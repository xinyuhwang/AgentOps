import type { Step } from "@/db/schema";
import type { HistoryEntry } from "@/core/llm/types";

/**
 * Rebuilds the model-facing conversation from persisted steps alone.
 *
 * This function is the reason the architecture works: nothing about a run's
 * progress lives in worker memory, so any worker can pick up any run and
 * produce the same next request. If you ever find yourself wanting to thread
 * extra state into the loop, it belongs in a column, not a closure.
 */
export function buildHistory(task: string, steps: Step[]): HistoryEntry[] {
  const history: HistoryEntry[] = [{ role: "user", text: task }];

  const ordered = [...steps].sort(
    (a, b) => a.ordinal - b.ordinal || a.attempt - b.attempt,
  );

  /** Tool results for the assistant turn currently being assembled. */
  let pendingResults: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }> = [];

  const flushResults = () => {
    if (pendingResults.length > 0) {
      history.push({ role: "tool_results", results: pendingResults });
      pendingResults = [];
    }
  };

  for (const step of ordered) {
    if (step.type === "thought") {
      flushResults();
      const content = (step.result as { content?: unknown[] } | null)?.content;
      if (Array.isArray(content) && content.length > 0) {
        // Replayed verbatim — thinking blocks must be byte-identical.
        history.push({ role: "assistant", content });
      }
      continue;
    }

    if (step.type === "tool_result") {
      // Retries share an ordinal. Only the last attempt is what the model was
      // actually shown, so earlier attempts inform the trace but not the
      // conversation.
      if (!isFinalAttempt(ordered, step)) continue;

      const toolUseId =
        (step.arguments as { toolUseId?: string } | null)?.toolUseId ?? step.id;
      pendingResults.push({
        toolUseId,
        content: JSON.stringify(
          step.status === "ok"
            ? (step.result ?? {})
            : { error: step.errorDetail ?? "Tool failed" },
        ),
        isError: step.status !== "ok",
      });
    }
  }

  flushResults();
  return history;
}

function isFinalAttempt(ordered: Step[], step: Step): boolean {
  const maxAttempt = ordered
    .filter((s) => s.ordinal === step.ordinal && s.type === "tool_result")
    .reduce((max, s) => Math.max(max, s.attempt), 0);
  return step.attempt === maxAttempt;
}

/** Counts model turns, which is what `max_steps` actually bounds. */
export function modelTurnCount(steps: Step[]): number {
  return steps.filter((s) => s.type === "thought").length;
}
