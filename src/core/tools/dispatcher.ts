import { AgentOpsError, classifyUnknown } from "../errors";
import type { ErrorType } from "@/db/schema";
import { BUILTIN_BY_KEY } from "./builtin";

/**
 * §7.4 — every tool call goes through one dispatcher with a uniform timeout and
 * retry wrapper, so limits behave identically across tool types instead of each
 * tool inventing its own. Each attempt is surfaced through `onAttemptSettled`
 * as it happens, which is how a retry lands as its own `Step` row rather than
 * being collapsed into the final outcome.
 */

export type AttemptRecord = {
  attempt: number;
  ok: boolean;
  result: Record<string, unknown> | null;
  errorType: ErrorType | null;
  errorDetail: string | null;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

export type DispatchOptions = {
  timeoutMs: number;
  /** Total attempts are maxRetries + 1. */
  maxRetries: number;
  onAttemptSettled?: (record: AttemptRecord) => Promise<void>;
};

export type DispatchOutcome = {
  ok: boolean;
  result: Record<string, unknown> | null;
  errorType: ErrorType | null;
  errorDetail: string | null;
  attempts: number;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        // Retryable: a timeout is the canonical transient failure.
        new AgentOpsError("timeout", `Tool timed out after ${timeoutMs}ms`, true),
      );
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function dispatchTool(
  toolKey: string,
  args: Record<string, unknown>,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const tool = BUILTIN_BY_KEY.get(toolKey);

  if (!tool) {
    // The model hallucinated a tool. Not retryable, and not an engine crash —
    // it goes back as a tool_result so the model can correct itself.
    const record = failedAttempt(
      1,
      "tool_error",
      `Unknown tool "${toolKey}"`,
    );
    await options.onAttemptSettled?.(record);
    return {
      ok: false,
      result: null,
      errorType: "tool_error",
      errorDetail: record.errorDetail,
      attempts: 1,
    };
  }

  const totalAttempts = Math.max(1, options.maxRetries + 1);
  let last: AttemptRecord | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const startedAt = new Date();
    try {
      const result = await withTimeout(tool.handler(args), options.timeoutMs);
      const endedAt = new Date();
      const record: AttemptRecord = {
        attempt,
        ok: true,
        result,
        errorType: null,
        errorDetail: null,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };
      await options.onAttemptSettled?.(record);
      return {
        ok: true,
        result,
        errorType: null,
        errorDetail: null,
        attempts: attempt,
      };
    } catch (err) {
      const error = classifyUnknown(err);
      const endedAt = new Date();
      last = {
        attempt,
        ok: false,
        result: null,
        errorType: error.errorType,
        errorDetail: error.message,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      };
      await options.onAttemptSettled?.(last);

      // Bad arguments fail identically on every attempt; burning retries on
      // them just makes the trace noisier and the run slower.
      if (!error.retryable) break;
    }
  }

  return {
    ok: false,
    result: null,
    errorType: last?.errorType ?? "internal",
    errorDetail: last?.errorDetail ?? "Tool failed",
    attempts: last?.attempt ?? 1,
  };
}

function failedAttempt(
  attempt: number,
  errorType: ErrorType,
  detail: string,
): AttemptRecord {
  const now = new Date();
  return {
    attempt,
    ok: false,
    result: null,
    errorType,
    errorDetail: detail,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}
