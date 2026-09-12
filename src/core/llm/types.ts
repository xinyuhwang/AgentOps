/**
 * The provider seam (§7.1): the `model` column on AgentVersion is not tied to
 * one vendor's SDK. Everything the engine needs from a model is "given this
 * history, what is the next move" — a thought, some tool calls, or a final
 * answer.
 */

/**
 * History is rebuilt from persisted Steps on every iteration of the loop, so
 * this shape has to be reconstructable from the database alone. That is why
 * assistant turns carry raw provider content blocks: thinking blocks must be
 * echoed back byte-identical on the next request, and the only place they
 * survive a worker crash is the `steps` table.
 */
export type HistoryEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; content: unknown[] }
  | {
      role: "tool_results";
      results: Array<{ toolUseId: string; content: string; isError: boolean }>;
    };

export type ToolSpec = {
  key: string;
  description: string;
  jsonSchema: Record<string, unknown>;
};

export type ProposedToolCall = {
  /** Provider-side id; correlates the result back to the call. */
  id: string;
  toolKey: string;
  arguments: Record<string, unknown>;
};

export type Usage = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type ProviderTurn = {
  /** Raw blocks to replay verbatim on the next request. */
  assistantContent: unknown[];
  /** Human-readable one-liner for the trace timeline. */
  thoughtText: string | null;
  toolCalls: ProposedToolCall[];
  /** Non-null means the model is done. */
  finalText: string | null;
  usage: Usage;
};

export type ProviderRequest = {
  model: string;
  system: string;
  history: HistoryEntry[];
  tools: ToolSpec[];
};

export interface LlmProvider {
  readonly name: string;
  next(req: ProviderRequest): Promise<ProviderTurn>;
}
