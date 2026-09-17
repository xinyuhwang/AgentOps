import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersions, runs } from "@/db/schema";
import type { Scope } from "@/db/scope";

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
