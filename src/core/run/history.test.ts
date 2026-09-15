import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { buildHistory, modelTurnCount } from "./history";
import type { Step } from "@/db/schema";

/**
 * History reconstruction is the load-bearing function for crash recovery: if it
 * is wrong, a resumed run sends the model a different conversation than the
 * original worker would have. These are pure unit tests over step rows.
 */
function step(partial: Partial<Step> & Pick<Step, "ordinal" | "type">): Step {
  return {
    id: `step-${partial.ordinal}-${partial.attempt ?? 1}`,
    organizationId: "org",
    runId: "run",
    attempt: 1,
    label: "",
    toolDefinitionId: null,
    arguments: null,
    result: null,
    status: "ok",
    errorType: null,
    errorDetail: null,
    approvalState: null,
    approvedByUserId: null,
    approvalEdit: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: "0",
    startedAt: new Date(),
    endedAt: new Date(),
    durationMs: 0,
    ...partial,
  } as Step;
}

describe("history reconstruction", () => {
  test("starts with the task as the user turn", () => {
    const history = buildHistory("Do the thing", []);
    assert.deepEqual(history, [{ role: "user", text: "Do the thing" }]);
  });

  test("replays assistant content blocks verbatim", () => {
    const content = [
      { type: "thinking", thinking: "signed-block" },
      { type: "text", text: "calling a tool" },
    ];

    const history = buildHistory("task", [
      step({ ordinal: 0, type: "thought", result: { content } }),
    ]);

    assert.equal(history.length, 2);
    assert.deepEqual(history[1], { role: "assistant", content });
  });

  test("groups all tool results for one turn into a single message", () => {
    const history = buildHistory("task", [
      step({ ordinal: 0, type: "thought", result: { content: [{ type: "text" }] } }),
      step({ ordinal: 1, type: "tool_call" }),
      step({
        ordinal: 2,
        type: "tool_result",
        arguments: { toolUseId: "call_a" },
        result: { value: 1 },
      }),
      step({
        ordinal: 3,
        type: "tool_result",
        arguments: { toolUseId: "call_b" },
        result: { value: 2 },
      }),
    ]);

    const last = history[history.length - 1];
    assert.equal(last.role, "tool_results");
    // Splitting these across messages teaches the model to stop calling tools
    // in parallel, so they must arrive together.
    assert.equal(last.role === "tool_results" && last.results.length, 2);
  });

  test("only the final attempt of a retried step reaches the model", () => {
    const history = buildHistory("task", [
      step({ ordinal: 0, type: "thought", result: { content: [{ type: "text" }] } }),
      step({
        ordinal: 1,
        attempt: 1,
        type: "tool_result",
        status: "error",
        errorDetail: "timed out",
        arguments: { toolUseId: "call_a" },
      }),
      step({
        ordinal: 1,
        attempt: 2,
        type: "tool_result",
        status: "ok",
        result: { value: 42 },
        arguments: { toolUseId: "call_a" },
      }),
    ]);

    const last = history[history.length - 1];
    assert.equal(last.role, "tool_results");
    if (last.role !== "tool_results") return;

    assert.equal(last.results.length, 1);
    assert.equal(last.results[0].isError, false);
    assert.match(last.results[0].content, /42/);
  });

  test("a failed final attempt is sent back as an error result", () => {
    const history = buildHistory("task", [
      step({ ordinal: 0, type: "thought", result: { content: [{ type: "text" }] } }),
      step({
        ordinal: 1,
        type: "tool_result",
        status: "error",
        errorDetail: "tool exploded",
        arguments: { toolUseId: "call_a" },
      }),
    ]);

    const last = history[history.length - 1];
    if (last.role !== "tool_results") throw new Error("expected tool results");
    assert.equal(last.results[0].isError, true);
    assert.match(last.results[0].content, /tool exploded/);
  });

  test("steps are ordered by ordinal then attempt regardless of input order", () => {
    const history = buildHistory("task", [
      step({ ordinal: 3, type: "thought", result: { content: [{ type: "text", text: "second" }] } }),
      step({ ordinal: 0, type: "thought", result: { content: [{ type: "text", text: "first" }] } }),
    ]);

    assert.deepEqual(history[1], {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
    });
    assert.deepEqual(history[2], {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    });
  });

  test("approval and warning rows do not enter the conversation", () => {
    const history = buildHistory("task", [
      step({ ordinal: 0, type: "approval", approvalState: "pending" }),
      step({ ordinal: 1, type: "warning" }),
    ]);

    assert.equal(history.length, 1);
  });

  test("max_steps is bounded by model turns, not by row count", () => {
    const steps = [
      step({ ordinal: 0, type: "thought" }),
      step({ ordinal: 1, type: "tool_call" }),
      step({ ordinal: 2, type: "tool_result" }),
      step({ ordinal: 3, type: "thought" }),
    ];
    assert.equal(modelTurnCount(steps), 2);
  });
});
