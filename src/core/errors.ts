import type { ErrorType } from "@/db/schema";

/**
 * §7.6 — "the model returned nonsense" and "the tool timed out" are different
 * failures, and the inspector should not flatten them into one red icon.
 */
export class AgentOpsError extends Error {
  constructor(
    readonly errorType: ErrorType,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentOpsError";
  }
}

export function classifyUnknown(err: unknown): AgentOpsError {
  if (err instanceof AgentOpsError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentOpsError("internal", message);
}

export const ERROR_LABELS: Record<ErrorType, string> = {
  model_error: "Model error",
  tool_error: "Tool error",
  timeout: "Timed out",
  max_steps_exceeded: "Step limit reached",
  approval_rejected: "Approval rejected",
  internal: "Internal error",
};
