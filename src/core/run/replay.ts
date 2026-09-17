import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, steps as stepsTable, type Step } from "@/db/schema";
import { scoped, type Scope } from "@/db/scope";
import { loadSteps } from "./store";

/**
 * Replay = fork the trace (§7.3).
 *
 * Steps `0..N-1` are copied into a new run and the ordinary loop continues from
 * there, because [buildHistory] rebuilds a run's state purely from persisted
 * steps — the state machine needs no knowledge of replay at all. Two
 * consequences worth being explicit about:
 *
 *   - Nothing before the fork point re-executes, so a side-effecting call in
 *     the prefix is *copied*, not re-sent. That is the whole reason to fork
 *     rather than re-run.
 *   - Traces stay immutable. The source run is never touched; the copies are
 *     new rows under a new run id.
 */

export type ForkCheck = { ok: true } | { ok: false; reason: string };

/**
 * A fork point has to be a clean model-turn boundary.
 *
 * If the prefix ended immediately after a `tool_call`, the replayed
 * conversation would contain an assistant turn holding a `tool_use` block with
 * no matching `tool_result`, and the next model request would be rejected as
 * malformed. Checking the pairing directly is more general than only allowing
 * `thought` ordinals, and it catches a partially-retried tool call too.
 */
export function checkForkPoint(steps: Step[], fromOrdinal: number): ForkCheck {
  if (!Number.isInteger(fromOrdinal) || fromOrdinal < 0) {
    return { ok: false, reason: "The fork point must be a non-negative step number." };
  }

  const prefix = steps.filter((s) => s.ordinal < fromOrdinal);

  if (fromOrdinal > 0 && prefix.length === 0) {
    return { ok: false, reason: `This run has no step before ${fromOrdinal}.` };
  }

  // An unresolved approval cannot be carried into a replay: the copy would sit
  // pending forever, and the new run would have no way to make progress.
  const pending = prefix.find(
    (s) => s.type === "approval" && s.approvalState === "pending",
  );
  if (pending) {
    return {
      ok: false,
      reason:
        `Step ${pending.ordinal} is an unresolved approval. ` +
        "Approve or reject it before replaying past it.",
    };
  }

  const toolUseId = (step: Step): string | null =>
    (step.arguments as { toolUseId?: string } | null)?.toolUseId ?? null;

  /**
   * The ids that must be answered come from the *assistant content* on thought
   * steps, not from `tool_call` rows.
   *
   * A thought step replays verbatim as an assistant turn, and that turn is what
   * carries the `tool_use` blocks. Checking only `tool_call` rows would happily
   * allow a fork one step after a thought — copying the turn that requests a
   * tool while leaving its result behind, which is precisely the malformed
   * conversation this function exists to prevent.
   */
  const called = new Set<string>();
  for (const s of prefix) {
    if (s.type === "thought") {
      const content = (s.result as { content?: unknown[] } | null)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; id?: string };
        if (b?.type === "tool_use" && typeof b.id === "string") called.add(b.id);
      }
    } else if (s.type === "tool_call") {
      const id = toolUseId(s);
      if (id) called.add(id);
    }
  }

  const answered = new Set(
    prefix
      .filter((s) => s.type === "tool_result")
      .map(toolUseId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const id of called) {
    if (!answered.has(id)) {
      return {
        ok: false,
        reason:
          "That would cut the trace in the middle of a model turn, leaving a " +
          "tool call with no result. Pick the step where the next turn begins.",
      };
    }
  }

  return { ok: true };
}

/** Ordinals a replay may start from, for the UI to offer. */
export function eligibleForkOrdinals(steps: Step[]): number[] {
  const ordinals = [...new Set(steps.map((s) => s.ordinal))].sort((a, b) => a - b);
  return ordinals.filter((o) => o > 0 && checkForkPoint(steps, o).ok);
}

export async function replayRun(
  scope: Scope,
  sourceRunId: string,
  fromOrdinal: number,
): Promise<{ id: string }> {
  const [source] = await db
    .select()
    .from(runs)
    .where(scoped(runs, scope, eq(runs.id, sourceRunId)))
    .limit(1);

  if (!source) throw new Error("Run not found in this organization");

  const sourceSteps = await loadSteps(sourceRunId);
  const check = checkForkPoint(sourceSteps, fromOrdinal);
  if (!check.ok) throw new Error(check.reason);

  const prefix = sourceSteps.filter((s) => s.ordinal < fromOrdinal);
  const input = source.input as { task?: string };

  const [replay] = await db
    .insert(runs)
    .values({
      organizationId: scope.organizationId,
      // Same agent version: a replay compares against the config that produced
      // the original, not against whatever is in production now.
      agentVersionId: source.agentVersionId,
      label: source.label ? `Replay of ${source.label}` : "Replay",
      status: "queued",
      input: { task: input?.task ?? "" },
      replayedFromRunId: sourceRunId,
      replayedFromStepOrdinal: fromOrdinal,
      // The loop appends from here, so copied ordinals are never reused.
      nextOrdinal: fromOrdinal,
      /**
       * Totals start at zero even though the copied steps carry their original
       * cost. The replay did not spend that money — the source run did — and
       * avg-cost-per-run (§3.4) would double-count it otherwise. A copied step
       * is identifiable as `ordinal < replayed_from_step_ordinal`, so the two
       * numbers are reconcilable without another column.
       */
      tokensIn: 0,
      tokensOut: 0,
      costUsd: "0",
    })
    .returning({ id: runs.id });

  if (prefix.length > 0) {
    await db.insert(stepsTable).values(
      prefix.map((s) => ({
        runId: replay.id,
        organizationId: scope.organizationId,
        ordinal: s.ordinal,
        attempt: s.attempt,
        type: s.type,
        label: s.label,
        toolDefinitionId: s.toolDefinitionId,
        arguments: s.arguments,
        result: s.result,
        status: s.status,
        errorType: s.errorType,
        errorDetail: s.errorDetail,
        approvalState: s.approvalState,
        approvedByUserId: s.approvedByUserId,
        approvalEdit: s.approvalEdit,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        costUsd: s.costUsd,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
      })),
    );
  }

  return replay;
}
