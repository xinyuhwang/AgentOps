import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, steps } from "@/db/schema";
import type { ProposedToolCall } from "@/core/llm/types";
import { scoped, type Scope } from "@/db/scope";

export type ApprovalDecision =
  | { decision: "approve" }
  | { decision: "reject" }
  | { decision: "approve_edited"; toolCalls: ProposedToolCall[] };

/**
 * Resolves a pending approval and hands the run back to the worker pool.
 *
 * The run goes to `queued`, not straight to `running` — the worker claim is the
 * only place a run becomes running, so there is exactly one path into
 * execution and the concurrency cap cannot be bypassed by an approval.
 */
export async function resolveApproval(
  scope: Scope,
  stepId: string,
  outcome: ApprovalDecision,
  userId?: string | null,
): Promise<void> {
  const [step] = await db
    .select()
    .from(steps)
    .where(scoped(steps, scope, eq(steps.id, stepId)))
    .limit(1);

  if (!step || step.type !== "approval") {
    throw new Error("Approval step not found");
  }
  if (step.approvalState !== "pending") {
    // The single mutable field resolves exactly once; a second reviewer
    // clicking Approve must not re-run the tool calls.
    throw new Error("This approval has already been resolved");
  }

  const approvalState =
    outcome.decision === "reject"
      ? "rejected"
      : outcome.decision === "approve_edited"
        ? "approved_edited"
        : "approved";

  await db
    .update(steps)
    .set({
      approvalState,
      approvedByUserId: userId ?? null,
      approvalEdit:
        outcome.decision === "approve_edited"
          ? { toolCalls: outcome.toolCalls }
          : null,
    })
    .where(and(eq(steps.id, stepId), eq(steps.approvalState, "pending")));

  await db
    .update(runs)
    .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
    .where(scoped(runs, scope, eq(runs.id, step.runId)));
}
