import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersions, agents, runs, toolDefinitions } from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";
import { loadSteps } from "@/core/run/store";
import type { ErrorType, RunStatus, StepType } from "@/db/schema";

/**
 * The trace view model. Deliberately plain JSON: the same shape is rendered on
 * the server for first paint and polled from the API route while a run is in
 * flight, so both paths cannot drift. In Phase 2 the SSE stream emits one event
 * per step against this same shape.
 */
export type TraceStep = {
  id: string;
  ordinal: number;
  attempt: number;
  type: StepType;
  label: string;
  status: string;
  errorType: ErrorType | null;
  errorDetail: string | null;
  approvalState: string | null;
  approvalEdit: unknown;
  arguments: unknown;
  result: unknown;
  durationMs: number | null;
  startedAt: string;
  tool: { key: string; displayName: string; sideEffecting: boolean } | null;
};

export type TraceView = {
  run: {
    id: string;
    label: string | null;
    status: RunStatus;
    errorType: ErrorType | null;
    errorDetail: string | null;
    durationMs: number | null;
    costUsd: string;
    tokensIn: number;
    tokensOut: number;
    startedAt: string | null;
    endedAt: string | null;
    output: unknown;
    replayedFromRunId: string | null;
    replayedFromStepOrdinal: number | null;
  };
  agent: { id: string; name: string; versionNo: number; model: string };
  steps: TraceStep[];
};

export async function loadTraceView(runId: string): Promise<TraceView | null> {
  const scope = await currentScope();

  const [row] = await db
    .select({
      run: runs,
      versionNo: agentVersions.versionNo,
      model: agentVersions.model,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(runs)
    .innerJoin(agentVersions, eq(runs.agentVersionId, agentVersions.id))
    .innerJoin(agents, eq(agentVersions.agentId, agents.id))
    .where(scoped(runs, scope, eq(runs.id, runId)))
    .limit(1);

  if (!row) return null;

  const steps = await loadSteps(runId);

  const toolIds = [
    ...new Set(steps.map((s) => s.toolDefinitionId).filter(Boolean)),
  ] as string[];

  const tools = toolIds.length
    ? await db
        .select()
        .from(toolDefinitions)
        .where(inArray(toolDefinitions.id, toolIds))
    : [];

  const toolsById = new Map(tools.map((t) => [t.id, t]));

  return {
    run: {
      id: row.run.id,
      label: row.run.label,
      status: row.run.status,
      errorType: row.run.errorType,
      errorDetail: row.run.errorDetail,
      durationMs: row.run.durationMs,
      costUsd: row.run.costUsd,
      tokensIn: row.run.tokensIn,
      tokensOut: row.run.tokensOut,
      startedAt: row.run.startedAt?.toISOString() ?? null,
      endedAt: row.run.endedAt?.toISOString() ?? null,
      output: row.run.output,
      replayedFromRunId: row.run.replayedFromRunId,
      replayedFromStepOrdinal: row.run.replayedFromStepOrdinal,
    },
    agent: {
      id: row.agentId,
      name: row.agentName,
      versionNo: row.versionNo,
      model: row.model,
    },
    steps: steps.map((step) => {
      const tool = step.toolDefinitionId
        ? toolsById.get(step.toolDefinitionId)
        : null;
      return {
        id: step.id,
        ordinal: step.ordinal,
        attempt: step.attempt,
        type: step.type,
        label: step.label,
        status: step.status,
        errorType: step.errorType,
        errorDetail: step.errorDetail,
        approvalState: step.approvalState,
        approvalEdit: step.approvalEdit,
        arguments: step.arguments,
        result: step.result,
        durationMs: step.durationMs,
        startedAt: step.startedAt.toISOString(),
        tool: tool
          ? {
              key: tool.key,
              displayName: tool.displayName,
              sideEffecting: tool.sideEffecting,
            }
          : null,
      };
    }),
  };
}
