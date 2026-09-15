// See the note in `trace.ts` on why there is no `server-only` guard here.
import type { Scope } from "@/db/scope";
import {
  formatCursor,
  isTerminal,
  loadRunSummary,
  stepsAfter,
  type StepCursor,
  type TraceAgent,
  type TraceRun,
  type TraceStep,
} from "./trace";

/**
 * Live trace updates (§7.2).
 *
 * The stream is a *view onto persisted steps*, never the thing driving
 * execution: it reads rows the worker has already committed, so closing the
 * browser has no effect on the run, and reconnecting replays from the last
 * event the client actually received.
 *
 * There is no in-process pub/sub here on purpose. The worker and the web server
 * are separate processes, so an in-memory event bus would only ever see runs
 * advanced by whichever process happened to host the emitter. Re-reading
 * committed rows is correct regardless of which worker is advancing the run,
 * and it is what makes the resume path identical to the first-connect path.
 */

export type SseEvent =
  | { event: "run"; id?: string; data: { run: TraceRun; agent: TraceAgent } }
  | { event: "step"; id: string; data: TraceStep }
  | { event: "done"; data: { status: string } }
  | { event: "error"; data: { message: string } };

export type StreamOptions = {
  /** How often committed rows are re-read. */
  pollMs?: number;
  /** Comment frames keep proxies from closing an idle stream. */
  heartbeatMs?: number;
  signal?: AbortSignal;
  /** Test seam: stop after this many idle ticks rather than running forever. */
  maxIdleTicks?: number;
};

export function encodeSse(event: SseEvent): string {
  const lines: string[] = [];
  if ("id" in event && event.id) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.event}`);
  // A data field cannot contain a raw newline, and JSON.stringify never emits one.
  lines.push(`data: ${JSON.stringify(event.data)}`);
  return `${lines.join("\n")}\n\n`;
}

export function encodeComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Yields events for a run until it reaches a terminal status, the client
 * disconnects, or `maxIdleTicks` is exhausted.
 *
 * `awaiting_approval` is deliberately *not* terminal. A suspended run has
 * released its lease and may sit for minutes before someone approves it, so
 * treating silence as completion would close the stream exactly when the user
 * is looking at the approval panel.
 */
export async function* traceEvents(
  scope: Scope,
  runId: string,
  from: StepCursor | null,
  options: StreamOptions = {},
): AsyncGenerator<SseEvent> {
  const pollMs = options.pollMs ?? 400;
  const maxIdleTicks = options.maxIdleTicks ?? Infinity;

  let cursor = from;
  let lastStatus: string | null = null;
  let idleTicks = 0;

  while (!options.signal?.aborted) {
    const summary = await loadRunSummary(scope, runId);

    if (!summary) {
      yield { event: "error", data: { message: "Run not found" } };
      return;
    }

    const fresh = await stepsAfter(scope, runId, cursor);

    // Emit the run summary when the status moves, or alongside new steps so
    // cost and duration stay in step with the timeline.
    if (summary.run.status !== lastStatus || fresh.length > 0) {
      lastStatus = summary.run.status;
      yield { event: "run", data: summary };
    }

    for (const step of fresh) {
      // The id is what comes back as Last-Event-ID on reconnect.
      yield { event: "step", id: formatCursor(step), data: step };
      cursor = { ordinal: step.ordinal, attempt: step.attempt };
    }

    if (isTerminal(summary.run.status)) {
      yield { event: "done", data: { status: summary.run.status } };
      return;
    }

    idleTicks = fresh.length > 0 ? 0 : idleTicks + 1;
    if (idleTicks >= maxIdleTicks) return;

    await sleep(pollMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
