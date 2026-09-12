import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "./pricing";
import type { LlmProvider, ProviderRequest, ProviderTurn } from "./types";

const globalForClient = globalThis as unknown as { __anthropic?: Anthropic };

function client(): Anthropic {
  // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
  // profile — so an unset env var does not mean "no credentials".
  globalForClient.__anthropic ??= new Anthropic();
  return globalForClient.__anthropic;
}

function toMessages(
  history: ProviderRequest["history"],
): Anthropic.MessageParam[] {
  return history.map((entry): Anthropic.MessageParam => {
    if (entry.role === "user") {
      return { role: "user", content: entry.text };
    }
    if (entry.role === "assistant") {
      // Replayed verbatim: thinking blocks must come back byte-identical.
      return {
        role: "assistant",
        content: entry.content as Anthropic.ContentBlockParam[],
      };
    }
    // All tool results for one assistant turn go back in a *single* user
    // message — splitting them teaches the model to stop calling in parallel.
    return {
      role: "user",
      content: entry.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    };
  });
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    const response = await client().messages.create({
      model: req.model,
      max_tokens: 16000,
      system: req.system,
      thinking: { type: "adaptive" },
      messages: toMessages(req.history),
      tools: req.tools.map((t) => ({
        name: t.key,
        description: t.description,
        input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
      })),
    });

    const thoughts: string[] = [];
    const texts: string[] = [];
    const toolCalls: ProviderTurn["toolCalls"] = [];

    for (const block of response.content) {
      if (block.type === "thinking") {
        if (block.thinking) thoughts.push(block.thinking);
      } else if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          toolKey: block.name,
          // Never string-match a serialized tool input; the SDK has already
          // parsed it into an object for us.
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const tokensIn = response.usage.input_tokens ?? 0;
    const tokensOut = response.usage.output_tokens ?? 0;

    /**
     * A refusal is a successful HTTP response with no usable content — treated
     * as a terminal answer rather than a crash, so the trace records what
     * happened instead of a stack trace.
     */
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      return {
        assistantContent: response.content,
        thoughtText: null,
        toolCalls: [],
        finalText: `The model declined this request (${category}).`,
        usage: {
          tokensIn,
          tokensOut,
          costUsd: costUsd(req.model, tokensIn, tokensOut),
        },
      };
    }

    return {
      assistantContent: response.content,
      thoughtText: thoughts.join("\n\n") || null,
      toolCalls,
      // Tool calls pending means the turn is not final, even if text came back.
      finalText: toolCalls.length > 0 ? null : texts.join("\n").trim(),
      usage: {
        tokensIn,
        tokensOut,
        costUsd: costUsd(req.model, tokensIn, tokensOut),
      },
    };
  },
};
