"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agents } from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import {
  createAgentWithDraft,
  saveAgentConfigFor,
} from "@/core/agents/service";
import { resolveApproval } from "@/core/run/approvals";

/**
 * Thin adapter: parses the form and delegates to the agent service, which owns
 * the versioning rule (edit v1 in place until a run references it, cut a new
 * version after that).
 */
export async function saveAgentConfig(agentId: string, formData: FormData) {
  const scope = await currentScope();

  await saveAgentConfigFor(scope, agentId, {
    model: String(formData.get("model") ?? "claude-opus-5"),
    systemInstructions: String(formData.get("systemInstructions") ?? ""),
    maxSteps: Number(formData.get("maxSteps") ?? 12),
    timeoutMs: Number(formData.get("timeoutMs") ?? 30_000),
    maxRetries: Number(formData.get("maxRetries") ?? 2),
    requireApprovalForSideEffecting: formData.get("requireApproval") === "on",
    toolDefinitionIds: formData.getAll("tools").map(String).filter(Boolean),
  });

  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/agents");
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
    // A draft has never been configured, so there is nothing meaningful to run.
    throw new Error(
      "Configure and save this agent before running it — it has no production version yet.",
    );
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

  const { agentId } = await createAgentWithDraft(scope, {
    name,
    description: String(formData.get("description") ?? ""),
  });

  // Lands on Overview, which is where configuration actually happens. The
  // agent stays a draft until that form is saved.
  redirect(`/agents/${agentId}`);
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
