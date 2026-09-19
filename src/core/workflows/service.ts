import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersions, agents, runs, workflows } from "@/db/schema";
import { scoped, type Scope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import {
  buildInputSpec,
  parseInputSpec,
  validateAndRender,
  type WorkflowInputSpec,
} from "./template";

/**
 * Workflows are *captured from a successful run*, never built on a canvas
 * (§3.5). That is why creation takes a run id rather than a step list: the
 * steps already exist, and the workflow is a pointer to the version that
 * produced them plus a way to supply fresh inputs.
 */
export async function createWorkflowFromRun(
  scope: Scope,
  runId: string,
  params: { name: string; template: string },
): Promise<{ id: string }> {
  const [run] = await db
    .select()
    .from(runs)
    .where(scoped(runs, scope, eq(runs.id, runId)))
    .limit(1);

  if (!run) throw new Error("Run not found in this organization");
  if (run.status !== "completed") {
    // Saving a failed run as a reusable workflow would enshrine the failure.
    throw new Error("Only a completed run can be saved as a workflow");
  }

  const name = params.name.trim();
  if (!name) throw new Error("A workflow needs a name");

  const template = params.template.trim();
  if (!template) throw new Error("A workflow needs a task template");

  const spec = buildInputSpec(template);

  const [workflow] = await db
    .insert(workflows)
    .values({
      organizationId: scope.organizationId,
      name,
      sourceRunId: runId,
      // Pinned: re-running a workflow uses the version that produced the
      // original, not whatever happens to be in production later.
      agentVersionId: run.agentVersionId,
      inputSchema: spec,
    })
    .returning({ id: workflows.id });

  return workflow;
}

export type WorkflowDetail = {
  id: string;
  name: string;
  createdAt: Date;
  sourceRunId: string | null;
  agentVersionId: string;
  agentId: string;
  agentName: string;
  versionNo: number;
  model: string;
  spec: WorkflowInputSpec;
  runCount: number;
};

export async function getWorkflow(
  scope: Scope,
  workflowId: string,
): Promise<WorkflowDetail | null> {
  const [row] = await db
    .select({
      workflow: workflows,
      agentId: agents.id,
      agentName: agents.name,
      versionNo: agentVersions.versionNo,
      model: agentVersions.model,
    })
    .from(workflows)
    .innerJoin(agentVersions, eq(workflows.agentVersionId, agentVersions.id))
    .innerJoin(agents, eq(agentVersions.agentId, agents.id))
    .where(scoped(workflows, scope, eq(workflows.id, workflowId)))
    .limit(1);

  if (!row) return null;

  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(scoped(runs, scope, eq(runs.workflowId, workflowId)));

  return {
    id: row.workflow.id,
    name: row.workflow.name,
    createdAt: row.workflow.createdAt,
    sourceRunId: row.workflow.sourceRunId,
    agentVersionId: row.workflow.agentVersionId,
    agentId: row.agentId,
    agentName: row.agentName,
    versionNo: row.versionNo,
    model: row.model,
    spec: parseInputSpec(row.workflow.inputSchema),
    runCount: runRows.length,
  };
}

export async function listWorkflows(scope: Scope) {
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      createdAt: workflows.createdAt,
      agentName: agents.name,
      versionNo: agentVersions.versionNo,
      inputSchema: workflows.inputSchema,
    })
    .from(workflows)
    .innerJoin(agentVersions, eq(workflows.agentVersionId, agentVersions.id))
    .innerJoin(agents, eq(agentVersions.agentId, agents.id))
    .where(scoped(workflows, scope))
    .orderBy(desc(workflows.createdAt));

  return rows.map((r) => ({
    ...r,
    variables: parseInputSpec(r.inputSchema).variables,
  }));
}

export type RunWorkflowResult =
  | { ok: true; runId: string }
  | { ok: false; errors: string[] };

/**
 * Validates inputs, renders the task and enqueues a run against the pinned
 * version. Shared by the re-run form and the public API so the two cannot
 * disagree about what a valid input is.
 */
export async function runWorkflow(
  scope: Scope,
  workflowId: string,
  values: unknown,
): Promise<RunWorkflowResult> {
  const workflow = await getWorkflow(scope, workflowId);
  if (!workflow) return { ok: false, errors: ["Workflow not found."] };

  const rendered = validateAndRender(workflow.spec, values);
  if (!rendered.ok) return { ok: false, errors: rendered.errors };

  const run = await enqueueRun(scope, {
    agentVersionId: workflow.agentVersionId,
    task: rendered.task,
    label: workflow.name,
    workflowId: workflow.id,
  });

  return { ok: true, runId: run.id };
}
