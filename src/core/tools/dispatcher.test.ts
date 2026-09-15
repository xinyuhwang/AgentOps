import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { dispatchTool, type AttemptRecord, type ToolRegistry } from "./dispatcher";
import { AgentOpsError } from "../errors";
import type { BuiltinTool } from "./builtin";

function fakeTool(
  key: string,
  handler: BuiltinTool["handler"],
  sideEffecting = false,
): BuiltinTool {
  return {
    key,
    version: 1,
    displayName: key,
    description: "",
    jsonSchema: { type: "object" },
    sideEffecting,
    credentialRef: null,
    handler,
  };
}

function registryOf(...tools: BuiltinTool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.key, t]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tool dispatcher", () => {
  test("a successful call returns its result in one attempt", async () => {
    const out = await dispatchTool("calculator", { expression: "(3 + 4) * 2" }, {
      timeoutMs: 1000,
      maxRetries: 2,
    });

    assert.equal(out.ok, true);
    assert.equal(out.attempts, 1);
    assert.equal(out.result?.value, 14);
    assert.equal(out.errorType, null);
  });

  test("an unknown tool fails as tool_error without retrying", async () => {
    const out = await dispatchTool("no_such_tool", {}, {
      timeoutMs: 1000,
      maxRetries: 3,
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, "tool_error");
    // Retrying a hallucinated tool name cannot help; it just slows the run.
    assert.equal(out.attempts, 1);
  });

  test("bad arguments are not retried", async () => {
    const attempts: AttemptRecord[] = [];
    const out = await dispatchTool("calculator", { expression: "drop table x" }, {
      timeoutMs: 1000,
      maxRetries: 3,
      onAttemptSettled: async (r) => void attempts.push(r),
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, "tool_error");
    assert.equal(out.attempts, 1);
    assert.equal(attempts.length, 1);
  });

  test("a timeout is retried up to maxRetries and each attempt is surfaced", async () => {
    const registry = registryOf(
      fakeTool("slow", async () => {
        await sleep(200);
        return { never: "reached" };
      }),
    );

    const attempts: AttemptRecord[] = [];
    const out = await dispatchTool("slow", {}, {
      timeoutMs: 10,
      maxRetries: 2,
      registry,
      onAttemptSettled: async (r) => void attempts.push(r),
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, "timeout");
    // maxRetries + 1 total attempts.
    assert.equal(out.attempts, 3);
    // Each one is reported as it settles, which is what lets the machine
    // persist a separate Step row per attempt.
    assert.equal(attempts.length, 3);
    assert.deepEqual(
      attempts.map((a) => a.attempt),
      [1, 2, 3],
    );
    assert.ok(attempts.every((a) => a.ok === false && a.errorType === "timeout"));
  });

  test("a transient failure succeeds on a later attempt", async () => {
    let calls = 0;
    const registry = registryOf(
      fakeTool("flaky", async () => {
        calls++;
        if (calls < 3) {
          throw new AgentOpsError("tool_error", "transient", true);
        }
        return { ok: true, calls };
      }),
    );

    const attempts: AttemptRecord[] = [];
    const out = await dispatchTool("flaky", {}, {
      timeoutMs: 1000,
      maxRetries: 3,
      registry,
      onAttemptSettled: async (r) => void attempts.push(r),
    });

    assert.equal(out.ok, true);
    assert.equal(out.attempts, 3);
    assert.equal(attempts.length, 3);
    assert.deepEqual(
      attempts.map((a) => a.ok),
      [false, false, true],
    );
  });

  test("a non-retryable error stops immediately even with retries available", async () => {
    let calls = 0;
    const registry = registryOf(
      fakeTool("hard-fail", async () => {
        calls++;
        throw new AgentOpsError("tool_error", "permanent", false);
      }),
    );

    const out = await dispatchTool("hard-fail", {}, {
      timeoutMs: 1000,
      maxRetries: 5,
      registry,
    });

    assert.equal(out.ok, false);
    assert.equal(calls, 1);
    assert.equal(out.attempts, 1);
  });

  test("an unexpected throw is classified as internal rather than crashing", async () => {
    const registry = registryOf(
      fakeTool("boom", async () => {
        throw new TypeError("undefined is not a function");
      }),
    );

    const out = await dispatchTool("boom", {}, {
      timeoutMs: 1000,
      maxRetries: 1,
      registry,
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, "internal");
    assert.match(out.errorDetail ?? "", /not a function/);
  });

  test("only SELECT reaches the database tool", async () => {
    const denied = await dispatchTool("database_query", { sql: "delete from orders" }, {
      timeoutMs: 1000,
      maxRetries: 0,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.errorType, "tool_error");

    const allowed = await dispatchTool("database_query", { sql: "select 1" }, {
      timeoutMs: 1000,
      maxRetries: 0,
    });
    assert.equal(allowed.ok, true);
  });
});
