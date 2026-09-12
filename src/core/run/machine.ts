import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  agentVersionTools,
  agentVersions,
  runs,
  toolDefinitions,
  type Step,
  type ToolDefinition,
} from "@/db/schema";
import { getProvider } from "@/core/llm";
import type { ProposedToolCall } from "@/core/llm/types";
import { dispatchTool } from "@/core/tools/dispatcher";
import { classifyUnknown } from "@/core/errors";
import { buildHistory, modelTurnCount } from "./history";
import { LEASE_MS } from "./claim";
import {
  addUsageToRun,
  appendStep,
  finishRun,
  loadSteps,
  renewLease,
  reserveOrdinal,
  suspendForApproval,
} from "./store";

/**
 * The durable run loop.
 *
 * Every iteration reads the run's state back out of Postgres, decides one
 * thing, and writes the result before deciding the next. Nothing is carried in
 * a closure between iterations. That is what makes all three of these true
 * with the same machinery:
 *   - a killed worker resumes from the last persisted step;
 *   - a run pauses for human approval and continues minutes later;
 *   - a run completes whether or not anyone has the trace open.
 */

type RunContext = {
  runId: string;
  organizationId: string;
  workerId: string;
  task: string;
  version: typeof agentVersions.$inferSelect;
  tools: ToolDefinition[];
};

type TickResult = "continue" | "suspended" | "done";

export async function advanceRun(
  runId: string,
  workerId: string,
): Promise<void> {
  const ctx = await loadContext(runId, workerId);
  if (!ctx) return;

  try {
    for (;;) {
      // Losing the lease means another worker has taken over (we were too slow
      // and our lease expired). Stop rather than write into its run.
      if (!(await renewLease(runId, workerId, LEASE_MS))) return;

      const result = await tick(ctx);
      if (result !== "continue") return;
    }
  } catch (err) {
    const error = classifyUnknown(err);
    await finishRun(runId, {
      status: "failed",
      errorType: error.errorType,
      errorDetail: error.message,
    });
  }
}

async function tick(ctx: RunContext): Promise<TickResult> {
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, ctx.runId))
    .limit(1);

  if (!run || run.status !== "running") return "done";

  const steps = await loadSteps(ctx.runId);

  // A resolved approval is work waiting to be picked up — handle it before
  // asking the model for anything new.
  const resolved = resolvedApproval(steps);
  if (resolved) return handleResolvedApproval(ctx, resolved);

  if (modelTurnCount(steps) >= ctx.version.maxSteps) {
    await finishRun(ctx.runId, {
      status: "failed",
      errorType: "max_steps_exceeded",
      errorDetail: `Run hit its limit of ${ctx.version.maxSteps} model steps`,
    });
    return "done";
  }

  const provider = getProvider();
  const startedAt = new Date();

  let turn;
  try {
    turn = await provider.next({
      model: ctx.version.model,
      system: ctx.version.systemInstructions,
      history: buildHistory(ctx.task, steps),
      tools: ctx.tools.map((t) => ({
        key: t.key,
        description: t.description,
        jsonSchema: t.jsonSchema as Record<string, unknown>,
      })),
    });
  } catch (err) {
    const error = classifyUnknown(err);
    await appendStep({
      runId: ctx.runId,
      organizationId: ctx.organizationId,
      ordinal: await reserveOrdinal(ctx.runId),
      type: "warning",
      label: "Model call failed",
      status: "error",
      errorType: "model_error",
      errorDetail: error.message,
      startedAt,
    });
    await finishRun(ctx.runId, {
      status: "failed",
      errorType: "model_error",
      errorDetail: error.message,
    });
    return "done";
  }

  const endedAt = new Date();

  await appendStep({
    runId: ctx.runId,
    organizationId: ctx.organizationId,
    ordinal: await reserveOrdinal(ctx.runId),
    type: "thought",
    label: turn.thoughtText?.split("\n")[0]?.slice(0, 120) ?? "Model turn",
    // The raw blocks are the replay payload for the next request.
    result: { content: turn.assistantContent, text: turn.thoughtText },
    tokensIn: turn.usage.tokensIn,
    tokensOut: turn.usage.tokensOut,
    costUsd: turn.usage.costUsd,
    startedAt,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
  });

  await addUsageToRun(
    ctx.runId,
    turn.usage.tokensIn,
    turn.usage.tokensOut,
    turn.usage.costUsd,
  );

  if (turn.toolCalls.length === 0) {
    const answer = turn.finalText ?? "";
    await appendStep({
      runId: ctx.runId,
      organizationId: ctx.organizationId,
      ordinal: await reserveOrdinal(ctx.runId),
      type: "completion",
      label: "Completed",
      result: { output: answer },
    });
    await finishRun(ctx.runId, {
      status: "completed",
      output: { text: answer },
    });
    return "done";
  }

  return executeToolCalls(ctx, turn.toolCalls);
}

/**
 * The approval gate (§3.2). Scope comes from the tool definition's
 * `side_effecting` flag — an agent-level "block external actions" switch would
 * have no way to decide what "external" means.
 */
async function executeToolCalls(
  ctx: RunContext,
  toolCalls: ProposedToolCall[],
): Promise<TickResult> {
  const gated =
    ctx.version.requireApprovalForSideEffecting &&
    toolCalls.some((call) => toolByKey(ctx, call.toolKey)?.sideEffecting);

  if (gated) {
    const names = toolCalls.map((c) => c.toolKey).join(", ");
    await appendStep({
      runId: ctx.runId,
      organizationId: ctx.organizationId,
      ordinal: await reserveOrdinal(ctx.runId),
      type: "approval",
      label: `Approval required: ${names}`,
      arguments: { toolCalls },
      approvalState: "pending",
    });
    // Release the lease. The run is not running and must not hold a worker;
    // it resumes when a human resolves the approval, which re-queues it.
    await suspendForApproval(ctx.runId);
    return "suspended";
  }

  await runToolCalls(ctx, toolCalls);
  return "continue";
}

async function runToolCalls(
  ctx: RunContext,
  toolCalls: ProposedToolCall[],
): Promise<void> {
  for (const call of toolCalls) {
    const definition = toolByKey(ctx, call.toolKey);

    await appendStep({
      runId: ctx.runId,
      organizationId: ctx.organizationId,
      ordinal: await reserveOrdinal(ctx.runId),
      type: "tool_call",
      label: call.toolKey,
      toolDefinitionId: definition?.id ?? null,
      arguments: { toolUseId: call.id, arguments: call.arguments },
    });

    // One ordinal for the result; each retry is another `attempt` row under it,
    // so the timeline can show "attempt 2 of 3" honestly.
    const resultOrdinal = await reserveOrdinal(ctx.runId);

    await dispatchTool(call.toolKey, call.arguments, {
      timeoutMs: ctx.version.timeoutMs,
      maxRetries: ctx.version.maxRetries,
      onAttemptSettled: async (record) => {
        await appendStep({
          runId: ctx.runId,
          organizationId: ctx.organizationId,
          ordinal: resultOrdinal,
          attempt: record.attempt,
          type: "tool_result",
          label: record.ok
            ? `${call.toolKey} result`
            : `${call.toolKey} failed (attempt ${record.attempt})`,
          toolDefinitionId: definition?.id ?? null,
          arguments: { toolUseId: call.id },
          result: record.result,
          status: record.ok ? "ok" : "error",
          errorType: record.errorType,
          errorDetail: record.errorDetail,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          durationMs: record.durationMs,
        });
      },
    });
  }
}

/**
 * Finds an approval step that a human has resolved but whose tool calls have
 * not run yet — i.e. nothing was appended after it.
 */
function resolvedApproval(steps: Step[]): Step | null {
  const approvals = steps.filter((s) => s.type === "approval");
  const last = approvals[approvals.length - 1];
  if (!last || last.approvalState === "pending" || !last.approvalState) {
    return null;
  }
  const hasLaterWork = steps.some((s) => s.ordinal > last.ordinal);
  return hasLaterWork ? null : last;
}

async function handleResolvedApproval(
  ctx: RunContext,
  approval: Step,
): Promise<TickResult> {
  if (approval.approvalState === "rejected") {
    await appendStep({
      runId: ctx.runId,
      organizationId: ctx.organizationId,
      ordinal: await reserveOrdinal(ctx.runId),
      type: "completion",
      label: "Rejected by reviewer",
      status: "rejected",
    });
    await finishRun(ctx.runId, {
      status: "failed",
      errorType: "approval_rejected",
      errorDetail: "A reviewer rejected the pending tool call",
    });
    return "done";
  }

  // An edited approval runs the reviewer's arguments, not the model's. The
  // original proposal stays on the step, so the trace can show what changed.
  const edited = (approval.approvalEdit as { toolCalls?: ProposedToolCall[] } | null)
    ?.toolCalls;
  const original = (approval.arguments as { toolCalls?: ProposedToolCall[] } | null)
    ?.toolCalls;
  const toRun = edited ?? original ?? [];

  await runToolCalls(ctx, toRun);
  return "continue";
}

function toolByKey(ctx: RunContext, key: string): ToolDefinition | undefined {
  return ctx.tools.find((t) => t.key === key);
}

async function loadContext(
  runId: string,
  workerId: string,
): Promise<RunContext | null> {
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!run) return null;

  const [version] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, run.agentVersionId))
    .limit(1);
  if (!version) return null;

  // Tools are read through the join, so a run always sees the exact versions
  // pinned to its agent version — not whatever the registry holds today.
  const tools = await db
    .select({ tool: toolDefinitions })
    .from(agentVersionTools)
    .innerJoin(
      toolDefinitions,
      eq(agentVersionTools.toolDefinitionId, toolDefinitions.id),
    )
    .where(eq(agentVersionTools.agentVersionId, version.id));

  const input = run.input as { task?: string };

  return {
    runId,
    organizationId: run.organizationId,
    workerId,
    task: input?.task ?? "(no task given)",
    version,
    tools: tools.map((t) => t.tool),
  };
}
