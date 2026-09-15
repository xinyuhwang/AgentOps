/**
 * No `server-only` guard here, unlike `queries.ts`: the test runner imports
 * these functions directly, and that package throws outside Next's bundler.
 * These modules are server-side by construction anyway — they import the
 * Postgres client, which cannot run in a browser. The client component takes
 * only `import type` from this file, which erases at compile time.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  agentVersions,
  agents,
  runs,
  steps as stepsTable,
  toolDefinitions,
} from "@/db/schema";
import { currentScope, scoped, type Scope } from "@/db/scope";
import { loadSteps } from "@/core/run/store";
import type {
  ErrorType,
  RunStatus,
  Step,
  StepType,
  ToolDefinition,
} from "@/db/schema";

/**
 * The trace view model. Deliberately plain JSON: the server-rendered first
 * paint, the JSON read route and the SSE stream all emit these same shapes, so
 * the three paths cannot drift apart.
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

export type TraceRun = {
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

export type TraceAgent = {
  id: string;
  name: string;
  versionNo: number;
  model: string;
};

export type TraceView = {
  run: TraceRun;
  agent: TraceAgent;
  steps: TraceStep[];
};

/** Terminal statuses end the stream; `awaiting_approval` deliberately does not. */
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export function toTraceStep(
  step: Step,
  toolsById: Map<string, ToolDefinition>,
): TraceStep {
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
}

async function loadToolsFor(
  steps: Step[],
): Promise<Map<string, ToolDefinition>> {
  const ids = [
    ...new Set(steps.map((s) => s.toolDefinitionId).filter(Boolean)),
  ] as string[];

  if (ids.length === 0) return new Map();

  const rows = await db
    .select()
    .from(toolDefinitions)
    .where(inArray(toolDefinitions.id, ids));

  return new Map(rows.map((t) => [t.id, t]));
}

function toTraceRun(run: typeof runs.$inferSelect): TraceRun {
  return {
    id: run.id,
    label: run.label,
    status: run.status,
    errorType: run.errorType,
    errorDetail: run.errorDetail,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    output: run.output,
    replayedFromRunId: run.replayedFromRunId,
    replayedFromStepOrdinal: run.replayedFromStepOrdinal,
  };
}

/**
 * Run + agent without the steps. The stream re-reads this on every tick, so
 * loading the whole trace each time would make watching a long run quadratic.
 */
export async function loadRunSummary(
  scope: Scope,
  runId: string,
): Promise<{ run: TraceRun; agent: TraceAgent } | null> {
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

  return {
    run: toTraceRun(row.run),
    agent: {
      id: row.agentId,
      name: row.agentName,
      versionNo: row.versionNo,
      model: row.model,
    },
  };
}

export async function loadTraceView(runId: string): Promise<TraceView | null> {
  const scope = await currentScope();
  const summary = await loadRunSummary(scope, runId);
  if (!summary) return null;

  const steps = await loadSteps(runId);
  const toolsById = await loadToolsFor(steps);

  return {
    ...summary,
    steps: steps.map((s) => toTraceStep(s, toolsById)),
  };
}

/**
 * The resume cursor. Steps are appended in (ordinal, attempt) order and never
 * rewritten, so that pair is a total order over a run's trace and can be
 * compared row-wise in SQL — which is what makes `Last-Event-ID` resumption
 * exact rather than approximate.
 */
export type StepCursor = { ordinal: number; attempt: number };

export function formatCursor(step: {
  ordinal: number;
  attempt: number;
}): string {
  return `${step.ordinal}-${step.attempt}`;
}

export function parseCursor(lastEventId: string | null | undefined): StepCursor | null {
  if (!lastEventId) return null;
  const match = /^(\d+)-(\d+)$/.exec(lastEventId.trim());
  if (!match) return null;
  return { ordinal: Number(match[1]), attempt: Number(match[2]) };
}

/** Steps strictly after the cursor, oldest first. */
export async function stepsAfter(
  scope: Scope,
  runId: string,
  cursor: StepCursor | null,
): Promise<TraceStep[]> {
  const rows = await db
    .select()
    .from(stepsTable)
    .where(
      cursor
        ? scoped(
            stepsTable,
            scope,
            and(
              eq(stepsTable.runId, runId),
              // Row-wise comparison: everything ordered after (ordinal, attempt).
              sql`(${stepsTable.ordinal}, ${stepsTable.attempt}) > (${cursor.ordinal}, ${cursor.attempt})`,
            ),
          )
        : scoped(stepsTable, scope, eq(stepsTable.runId, runId)),
    )
    .orderBy(asc(stepsTable.ordinal), asc(stepsTable.attempt));

  const toolsById = await loadToolsFor(rows);
  return rows.map((s) => toTraceStep(s, toolsById));
}
