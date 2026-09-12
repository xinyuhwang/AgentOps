"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersionTools, agentVersions, agents } from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { resolveApproval } from "@/core/run/approvals";

/**
 * Saving agent config creates a *new* AgentVersion — it never edits the
 * existing row. Once a Run points at a version, that version is the record of
 * what produced it, so editing in place would quietly rewrite history.
 */
export async function saveAgentConfig(agentId: string, formData: FormData) {
  const scope = await currentScope();

  const [agent] = await db
    .select()
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");

  const [latest] = await db
    .select({ versionNo: agentVersions.versionNo })
    .from(agentVersions)
    .where(scoped(agentVersions, scope, eq(agentVersions.agentId, agentId)))
    .orderBy(desc(agentVersions.versionNo))
    .limit(1);

  const [version] = await db
    .insert(agentVersions)
    .values({
      organizationId: scope.organizationId,
      agentId,
      versionNo: (latest?.versionNo ?? 0) + 1,
      model: String(formData.get("model") ?? "claude-opus-5"),
      systemInstructions: String(formData.get("systemInstructions") ?? ""),
      maxSteps: Number(formData.get("maxSteps") ?? 12),
      timeoutMs: Number(formData.get("timeoutMs") ?? 30_000),
      maxRetries: Number(formData.get("maxRetries") ?? 2),
      requireApprovalForSideEffecting:
        formData.get("requireApproval") === "on",
    })
    .returning();

  const toolIds = formData.getAll("tools").map(String).filter(Boolean);
  if (toolIds.length > 0) {
    await db.insert(agentVersionTools).values(
      toolIds.map((toolDefinitionId) => ({
        agentVersionId: version.id,
        toolDefinitionId,
      })),
    );
  }

  await db
    .update(agents)
    .set({ productionVersionId: version.id })
    .where(scoped(agents, scope, eq(agents.id, agentId)));

  revalidatePath(`/agents/${agentId}`);
}

export async function startRun(agentId: string, formData: FormData) {
  const scope = await currentScope();
  const task = String(formData.get("task") ?? "").trim();
  if (!task) return;

  const [agent] = await db
    .select({ productionVersionId: agents.productionVersionId })
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent?.productionVersionId) {
    throw new Error("This agent has no production version to run");
  }

  const run = await enqueueRun(scope, {
    agentVersionId: agent.productionVersionId,
    task,
  });

  // The run is queued, not executed — a worker picks it up. The trace page
  // polls, so it fills in as the worker makes progress.
  redirect(`/runs/${run.id}`);
}

export async function createAgent(formData: FormData) {
  const scope = await currentScope();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const [agent] = await db
    .insert(agents)
    .values({
      organizationId: scope.organizationId,
      name,
      description: String(formData.get("description") ?? "") || null,
    })
    .returning();

  const [version] = await db
    .insert(agentVersions)
    .values({
      organizationId: scope.organizationId,
      agentId: agent.id,
      versionNo: 1,
      model: "claude-opus-5",
      systemInstructions: "",
    })
    .returning();

  await db
    .update(agents)
    .set({ productionVersionId: version.id })
    .where(eq(agents.id, agent.id));

  redirect(`/agents/${agent.id}`);
}

export async function decideApproval(
  stepId: string,
  runId: string,
  decision: "approve" | "reject",
) {
  const scope = await currentScope();
  await resolveApproval(scope, stepId, { decision });
  revalidatePath(`/runs/${runId}`);
}
