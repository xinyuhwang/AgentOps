import { costUsd } from "./pricing";
import type { LlmProvider, ProviderRequest, ProviderTurn } from "./types";

/**
 * Deterministic scripted provider — the default when no API key is set.
 *
 * It decides the next move purely from the history it is handed, which is the
 * same history the engine rebuilds from Postgres. That makes it a genuine test
 * of the durable machine: kill the worker mid-run, let another one pick the
 * lease up, and the scripted turn it produces is identical to the one the dead
 * worker would have produced. A provider that kept its own counter would hide
 * exactly the bug this architecture exists to prevent.
 */
export const fakeProvider: LlmProvider = {
  name: "fake",

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    const priorToolTurns = req.history.filter(
      (h) => h.role === "tool_results",
    ).length;
    const task =
      req.history.find((h) => h.role === "user")?.role === "user"
        ? (req.history[0] as { role: "user"; text: string }).text
        : "the task";

    const usage = { tokensIn: 420, tokensOut: 96 };
    const withCost = {
      ...usage,
      costUsd: costUsd(req.model, usage.tokensIn, usage.tokensOut),
    };

    // Call each attached tool once, in order, then answer.
    const nextTool = req.tools[priorToolTurns];

    if (nextTool) {
      const id = `fake_call_${priorToolTurns}`;
      const thought = `Considering ${task}. Next: call ${nextTool.key}.`;
      return {
        assistantContent: [
          { type: "text", text: thought },
          {
            type: "tool_use",
            id,
            name: nextTool.key,
            input: scriptedArgumentsFor(nextTool.key, task),
          },
        ],
        thoughtText: thought,
        toolCalls: [
          {
            id,
            toolKey: nextTool.key,
            arguments: scriptedArgumentsFor(nextTool.key, task),
          },
        ],
        finalText: null,
        usage: withCost,
      };
    }

    const answer = `Done. Used ${priorToolTurns} tool call(s) to handle: ${task}`;
    return {
      assistantContent: [{ type: "text", text: answer }],
      thoughtText: null,
      toolCalls: [],
      finalText: answer,
      usage: withCost,
    };
  },
};

function scriptedArgumentsFor(
  toolKey: string,
  task: string,
): Record<string, unknown> {
  switch (toolKey) {
    case "calculator":
      return { expression: "2 + 2" };
    case "web_search":
      return { query: task.slice(0, 60) };
    case "database_query":
      return { sql: "select count(*) from orders" };
    case "send_email":
      return {
        to: "ops@example.com",
        subject: "Run summary",
        body: `Result for: ${task}`,
      };
    default:
      return { input: task };
  }
}
