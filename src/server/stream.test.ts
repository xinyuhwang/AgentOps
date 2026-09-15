import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { runs } from "@/db/schema";
import type { Scope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";
import { appendStep, reserveOrdinal } from "@/core/run/store";
import {
  formatCursor,
  isTerminal,
  parseCursor,
  stepsAfter,
} from "./trace";
import { encodeComment, encodeSse, traceEvents } from "./stream";
import {
  closeDb,
  createConfiguredAgent,
  createTestOrg,
  destroyTestOrg,
} from "@/test/helpers";

after(closeDb);

describe("SSE encoding", () => {
  test("a step event carries an id so reconnects can resume", () => {
    const frame = encodeSse({
      event: "step",
      id: "4-2",
      data: { ordinal: 4 } as never,
    });

    assert.match(frame, /^id: 4-2\n/);
    assert.match(frame, /\nevent: step\n/);
    assert.match(frame, /\ndata: \{"ordinal":4\}\n\n$/);
  });

  test("events end with a blank line, which is what dispatches them", () => {
    const frame = encodeSse({ event: "done", data: { status: "completed" } });
    assert.ok(frame.endsWith("\n\n"));
  });

  test("payload newlines cannot break the frame", () => {
    const frame = encodeSse({
      event: "error",
      data: { message: "line one\nline two" },
    });

    // JSON escapes the newline, so the data field stays a single line.
    const dataLines = frame.split("\n").filter((l) => l.startsWith("data: "));
    assert.equal(dataLines.length, 1);
    assert.match(frame, /line one\\nline two/);
  });

  test("heartbeats are comment frames, not events", () => {
    assert.equal(encodeComment("keep-alive"), ": keep-alive\n\n");
  });
});

describe("resume cursor", () => {
  test("round-trips through the event id", () => {
    assert.equal(formatCursor({ ordinal: 7, attempt: 3 }), "7-3");
    assert.deepEqual(parseCursor("7-3"), { ordinal: 7, attempt: 3 });
  });

  test("a missing or malformed id means start from the beginning", () => {
    assert.equal(parseCursor(null), null);
    assert.equal(parseCursor(""), null);
    assert.equal(parseCursor("not-a-cursor"), null);
    assert.equal(parseCursor("4-"), null);
    assert.equal(parseCursor("-4"), null);
  });

  test("whitespace from a header is tolerated", () => {
    assert.deepEqual(parseCursor(" 2-1 "), { ordinal: 2, attempt: 1 });
  });

  test("ordinal zero is a real cursor, not absence", () => {
    // `if (!ordinal)` would treat the first step as "no cursor" and resend it.
    assert.deepEqual(parseCursor("0-1"), { ordinal: 0, attempt: 1 });
  });

  test("awaiting_approval is not terminal", () => {
    // A suspended run may sit for minutes; closing the stream then would blank
    // the timeline exactly when the approval panel is on screen.
    assert.equal(isTerminal("awaiting_approval"), false);
    assert.equal(isTerminal("queued"), false);
    assert.equal(isTerminal("running"), false);
    assert.equal(isTerminal("completed"), true);
    assert.equal(isTerminal("failed"), true);
    assert.equal(isTerminal("cancelled"), true);
    assert.equal(isTerminal("timed_out"), true);
  });
});

describe("step selection after a cursor", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg();
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  test("retries at one ordinal are ordered by attempt and resumed exactly", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "cursor fixture",
    });

    // Three rows: ordinal 0, then two attempts at ordinal 1.
    const zero = await reserveOrdinal(id);
    await appendStep({
      runId: id,
      organizationId: scope.organizationId,
      ordinal: zero,
      type: "thought",
      label: "first",
    });

    const one = await reserveOrdinal(id);
    for (const attempt of [1, 2]) {
      await appendStep({
        runId: id,
        organizationId: scope.organizationId,
        ordinal: one,
        attempt,
        type: "tool_result",
        label: `attempt ${attempt}`,
      });
    }

    const all = await stepsAfter(scope, id, null);
    assert.deepEqual(
      all.map((s) => formatCursor(s)),
      ["0-1", "1-1", "1-2"],
    );

    // Resuming mid-ordinal must not re-send the attempt already delivered.
    const afterFirstAttempt = await stepsAfter(scope, id, {
      ordinal: 1,
      attempt: 1,
    });
    assert.deepEqual(
      afterFirstAttempt.map((s) => formatCursor(s)),
      ["1-2"],
    );

    const afterAll = await stepsAfter(scope, id, { ordinal: 1, attempt: 2 });
    assert.deepEqual(afterAll, []);
  });

  test("another organization's steps are not streamable", async () => {
    const other = await createTestOrg();
    try {
      const { versionId } = await createConfiguredAgent(scope, {
        toolKeys: ["calculator"],
      });
      const { id } = await enqueueRun(scope, {
        agentVersionId: versionId,
        task: "tenant fixture",
      });
      const ordinal = await reserveOrdinal(id);
      await appendStep({
        runId: id,
        organizationId: scope.organizationId,
        ordinal,
        type: "thought",
        label: "secret",
      });

      assert.deepEqual(await stepsAfter(other, id, null), []);
    } finally {
      await destroyTestOrg(other);
    }
  });
});

describe("trace event stream", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg();
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  async function collect(
    runId: string,
    from: Parameters<typeof traceEvents>[2],
  ) {
    const events = [];
    for await (const event of traceEvents(scope, runId, from, {
      pollMs: 5,
      maxIdleTicks: 1,
    })) {
      events.push(event);
    }
    return events;
  }

  test("a finished run streams its whole trace then closes", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "stream me",
    });

    const claimed = await claimNextRun("stream-worker");
    assert.equal(claimed?.id, id);
    await advanceRun(id, "stream-worker");

    const events = await collect(id, null);

    assert.equal(events[0].event, "run", "the run summary comes first");
    assert.equal(events.at(-1)?.event, "done", "a terminal run closes the stream");

    const stepEvents = events.filter((e) => e.event === "step");
    assert.ok(stepEvents.length > 0);
    // Every step event must carry an id, or reconnection cannot resume.
    assert.ok(stepEvents.every((e) => "id" in e && e.id));
  });

  test("resuming from a cursor sends only what came after it", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "resume me",
    });
    const claimed = await claimNextRun("resume-worker");
    assert.equal(claimed?.id, id);
    await advanceRun(id, "resume-worker");

    const full = await collect(id, null);
    const allSteps = full.filter((e) => e.event === "step");
    assert.ok(allSteps.length >= 3, "need a few steps to resume partway");

    const midpoint = allSteps[0];
    const resumed = await collect(id, parseCursor("id" in midpoint ? midpoint.id! : null));
    const resumedSteps = resumed.filter((e) => e.event === "step");

    assert.equal(resumedSteps.length, allSteps.length - 1);
    assert.ok(
      !resumedSteps.some(
        (e) => "id" in e && "id" in midpoint && e.id === midpoint.id,
      ),
      "the already-delivered step is not resent",
    );
  });

  test("a suspended run keeps the stream open instead of closing it", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "needs approval",
    });
    const claimed = await claimNextRun("suspend-worker");
    assert.equal(claimed?.id, id);
    await advanceRun(id, "suspend-worker");

    const [run] = await db.select().from(runs).where(eq(runs.id, id));
    assert.equal(run.status, "awaiting_approval");

    const events = await collect(id, null);

    assert.ok(
      events.some((e) => e.event === "step"),
      "the steps so far are delivered",
    );
    assert.ok(
      !events.some((e) => e.event === "done"),
      "an awaiting_approval run is not done",
    );
  });

  test("an unknown run yields an error rather than hanging", async () => {
    const events = await collect(
      "00000000-0000-0000-0000-000000000000",
      null,
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].event, "error");
  });

  test("aborting stops the stream", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "abort me",
    });

    const controller = new AbortController();
    const events = [];

    for await (const event of traceEvents(scope, id, null, {
      pollMs: 5,
      signal: controller.signal,
    })) {
      events.push(event);
      // The run is queued and never advanced, so without the abort this
      // generator would poll forever — which is the behaviour we want in
      // production and must be able to stop in a test.
      controller.abort();
    }

    assert.ok(events.length >= 1);
  });
});
