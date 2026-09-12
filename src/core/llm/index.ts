import { anthropicProvider } from "./anthropic";
import { fakeProvider } from "./fake";
import type { LlmProvider } from "./types";

/**
 * Defaults to the scripted provider so the whole loop runs end to end with no
 * API key and no spend. Set LLM_PROVIDER=anthropic for real calls.
 */
export function getProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER ?? "fake";
  if (configured === "anthropic") {
    return anthropicProvider;
  }
  return fakeProvider;
}

export * from "./types";
export { anthropicProvider, fakeProvider };
