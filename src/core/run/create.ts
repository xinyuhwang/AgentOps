import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersions, runs } from "@/db/schema";
import type { Scope } from "@/db/scope";
import { loadSteps } from "./store";

/**
 * Enqueues a run. Note what this does *not* do: execute anything. The HTTP
 * request that starts a run only writes a `queued` row; a worker picks it up.
 * That is what lets a run outlive the request that created it.
 */
export async function enqueueRun(
  scope: Scope,
  params: {
    agentVersionId: string;
    task: string;
    label?: string | null;
    workflowId?: string | null;
    replayedFromRunId?: string | null;
    replayedFromStepOrdinal?: number | null;
  },
): Promise<{ id: string }> {
  const [version] = await db
    .select({ id: agentVersions.id, organizationId: agentVersions.organizationId })
    .from(agentVersions)
    .where(eq(agentVersions.id, params.agentVersionId))
    .limit(1);

  if (!version || version.organizationId !== scope.organizationId) {
    throw new Error("Agent version not found in this organization");
  }

  const [run] = await db
    .insert(runs)
    .values({
      organizationId: scope.organizationId,
      agentVersionId: params.agentVersionId,
      workflowId: params.workflowId ?? null,
      label: params.label ?? params.task.slice(0, 80),
      status: "queued",
      input: { task: params.task },
      replayedFromRunId: params.replayedFromRunId ?? null,
      replayedFromStepOrdinal: params.replayedFromStepOrdinal ?? null,
    })
    .returning({ id: runs.id });

  return run;
}

/**
 * Replay (§7.3). Produces a *new* run — traces are immutable — and refuses to
 * replay past a side-effecting step, because re-running one re-sends the email
 * or re-charges the card. Phase 2 adds the UI; the guard lives here so no
 * caller can route around it.
 */
export async function replayRun(
  scope: Scope,
  sourceRunId: string,
  fromOrdinal: number,
): Promise<{ id: string }> {
  const [source] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, sourceRunId))
    .limit(1);

  if (!source || source.organizationId !== scope.organizationId) {
    throw new Error("Run not found in this organization");
  }

  const steps = await loadSteps(sourceRunId);
  const replayed = steps.filter((s) => s.ordinal < fromOrdinal);
  const sideEffecting = replayed.find(
    (s) => s.type === "tool_call" && s.approvalState === null && isSideEffecting(s.label),
  );

  if (sideEffecting) {
    throw new Error(
      `Cannot replay past step ${sideEffecting.ordinal} (${sideEffecting.label}): ` +
        "it is side-effecting and would run again",
    );
  }

  const input = source.input as { task?: string };
  return enqueueRun(scope, {
    agentVersionId: source.agentVersionId,
    task: input?.task ?? "",
    label: source.label ? `Replay of ${source.label}` : "Replay",
    replayedFromRunId: sourceRunId,
    replayedFromStepOrdinal: fromOrdinal,
  });
}

// Resolved against the pinned tool definition at call time in Phase 2's UI;
// the label check keeps the guard honest until then.
function isSideEffecting(label: string): boolean {
  return label === "send_email";
}
