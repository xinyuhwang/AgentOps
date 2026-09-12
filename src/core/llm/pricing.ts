/**
 * Per-token pricing, USD per 1M tokens. Feeds the cost-per-run metric in §3.4 —
 * which is only an honest number if these rates are real, so they are kept as
 * data rather than folded into the provider.
 */
export const MODEL_PRICING: Record<
  string,
  { inputPerMTok: number; outputPerMTok: number; label: string }
> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, label: "Claude Opus 5" },
  "claude-sonnet-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    label: "Claude Sonnet 5",
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    label: "Claude Haiku 4.5",
  },
  "claude-fable-5-1": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    label: "Claude Fable 5.1",
  },
};

export const DEFAULT_MODEL = "claude-opus-5";

/** Models offered in the Agent Overview selector (§3.2). */
export const SELECTABLE_MODELS = Object.entries(MODEL_PRICING).map(
  ([id, meta]) => ({ id, label: meta.label }),
);

export function costUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const pricing = MODEL_PRICING[model];
  // An unpriced model reports 0 rather than a fabricated number; the trace
  // shows "—" so nobody reads a guess as a measurement.
  if (!pricing) return 0;
  return (
    (tokensIn / 1_000_000) * pricing.inputPerMTok +
    (tokensOut / 1_000_000) * pricing.outputPerMTok
  );
}
