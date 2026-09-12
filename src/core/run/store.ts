import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, steps, type Step } from "@/db/schema";

/**
 * Ordinals are allocated in Postgres, not in the worker. Two workers racing on
 * the same run (which the lease should prevent, but belt and braces) cannot
 * hand out the same ordinal.
 */
export async function reserveOrdinal(runId: string): Promise<number> {
  const [row] = await db
    .update(runs)
    .set({ nextOrdinal: sql`${runs.nextOrdinal} + 1` })
    .where(eq(runs.id, runId))
    .returning({ next: runs.nextOrdinal });

  if (!row) throw new Error(`Run ${runId} not found while reserving ordinal`);
  // `returning` gives the post-increment value; the ordinal we just claimed is
  // the one before it.
  return row.next - 1;
}

export type AppendStepInput = {
  runId: string;
  organizationId: string;
  ordinal: number;
  attempt?: number;
  type: Step["type"];
  label: string;
  toolDefinitionId?: string | null;
  arguments?: unknown;
  result?: unknown;
  status?: Step["status"];
  errorType?: Step["errorType"];
  errorDetail?: string | null;
  approvalState?: Step["approvalState"];
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
};

export async function appendStep(input: AppendStepInput): Promise<Step> {
  const [row] = await db
    .insert(steps)
    .values({
      runId: input.runId,
      organizationId: input.organizationId,
      ordinal: input.ordinal,
      attempt: input.attempt ?? 1,
      type: input.type,
      label: input.label,
      toolDefinitionId: input.toolDefinitionId ?? null,
      arguments: input.arguments ?? null,
      result: input.result ?? null,
      status: input.status ?? "ok",
      errorType: input.errorType ?? null,
      errorDetail: input.errorDetail ?? null,
      approvalState: input.approvalState ?? null,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      costUsd: String(input.costUsd ?? 0),
      startedAt: input.startedAt ?? new Date(),
      endedAt: input.endedAt ?? new Date(),
      durationMs: input.durationMs ?? 0,
    })
    .returning();

  return row;
}

export async function loadSteps(runId: string): Promise<Step[]> {
  return db
    .select()
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(asc(steps.ordinal), asc(steps.attempt));
}

/** Rolls per-step usage up onto the run so cost-per-run is a stored number. */
export async function addUsageToRun(
  runId: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): Promise<void> {
  await db
    .update(runs)
    .set({
      tokensIn: sql`${runs.tokensIn} + ${tokensIn}`,
      tokensOut: sql`${runs.tokensOut} + ${tokensOut}`,
      costUsd: sql`${runs.costUsd} + ${String(costUsd)}`,
    })
    .where(eq(runs.id, runId));
}

export async function finishRun(
  runId: string,
  patch: {
    status: "completed" | "failed" | "timed_out" | "cancelled";
    output?: unknown;
    errorType?: Step["errorType"];
    errorDetail?: string | null;
  },
): Promise<void> {
  const [run] = await db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  const endedAt = new Date();
  await db
    .update(runs)
    .set({
      status: patch.status,
      output: patch.output ?? null,
      errorType: patch.errorType ?? null,
      errorDetail: patch.errorDetail ?? null,
      endedAt,
      durationMs: run?.startedAt
        ? endedAt.getTime() - run.startedAt.getTime()
        : null,
      // Release the lease: a finished run must never look claimable again.
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(runs.id, runId));
}

/** Suspends the run and releases the lease so a worker is not held open. */
export async function suspendForApproval(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({
      status: "awaiting_approval",
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(runs.id, runId));
}

export async function renewLease(
  runId: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const [row] = await db
    .update(runs)
    .set({ leaseExpiresAt: new Date(Date.now() + leaseMs) })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, workerId)))
    .returning({ id: runs.id });
  return Boolean(row);
}
