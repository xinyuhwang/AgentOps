import assert from "node:assert/strict";
import test, { after, afterEach, before, describe } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, type Step } from "@/db/schema";
import { scoped, type Scope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";
import { resolveApproval } from "@/core/run/approvals";
import { loadSteps } from "@/core/run/store";
import { buildHistory } from "@/core/run/history";
import { checkForkPoint, eligibleForkOrdinals, replayRun } from "./replay";
import {
  closeDb,
  createConfiguredAgent,
  createTestOrg,
  destroyTestOrg,
} from "@/test/helpers";

after(closeDb);

function step(partial: Partial<Step> & Pick<Step, "ordinal" | "type">): Step {
  return {
    id: `s-${partial.ordinal}-${partial.attempt ?? 1}`,
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

/**
 * A complete turn: thought -> tool_call -> tool_result, then a second thought.
 * The thought carries the `tool_use` block, as a real persisted turn does —
 * which is what makes ordinal 1 an invalid fork point.
 */
const TRACE: Step[] = [
  step({
    ordinal: 0,
    type: "thought",
    result: {
      content: [
        { type: "text", text: "calling a tool" },
        { type: "tool_use", id: "call_a", name: "calculator", input: {} },
      ],
    },
  }),
  step({ ordinal: 1, type: "tool_call", arguments: { toolUseId: "call_a" } }),
  step({ ordinal: 2, type: "tool_result", arguments: { toolUseId: "call_a" } }),
  step({ ordinal: 3, type: "thought" }),
  step({ ordinal: 4, type: "completion" }),
];

describe("fork point validation", () => {
  test("a model-turn boundary is a valid fork point", () => {
    assert.deepEqual(checkForkPoint(TRACE, 3), { ok: true });
  });

  test("cutting between a tool call and its result is refused", () => {
    // Forking at 2 would copy the tool_call but not the tool_result, leaving an
    // assistant turn whose tool_use block has no answer — the next model
    // request would be rejected as malformed.
    const result = checkForkPoint(TRACE, 2);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /middle of a model turn/);
  });

  test("an unresolved approval in the prefix is refused with a reason", () => {
    const withApproval = [
      step({ ordinal: 0, type: "thought" }),
      step({ ordinal: 1, type: "approval", approvalState: "pending" }),
    ];

    const result = checkForkPoint(withApproval, 2);
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.reason : "",
      /unresolved approval/,
    );
  });

  test("a resolved approval in the prefix is fine", () => {
    const withApproval = [
      step({ ordinal: 0, type: "thought" }),
      step({ ordinal: 1, type: "approval", approvalState: "approved" }),
      step({ ordinal: 2, type: "tool_call", arguments: { toolUseId: "c" } }),
      step({ ordinal: 3, type: "tool_result", arguments: { toolUseId: "c" } }),
      step({ ordinal: 4, type: "thought" }),
    ];

    assert.deepEqual(checkForkPoint(withApproval, 4), { ok: true });
  });

  test("negative and non-integer fork points are refused", () => {
    assert.equal(checkForkPoint(TRACE, -1).ok, false);
    assert.equal(checkForkPoint(TRACE, 1.5).ok, false);
  });

  test("a fork point beyond the trace is refused", () => {
    assert.equal(checkForkPoint([], 3).ok, false);
  });

  test("eligible ordinals exclude zero and mid-turn cuts", () => {
    // 0 copies nothing; 1 and 2 would strand the turn's tool_use block.
    assert.deepEqual(eligibleForkOrdinals(TRACE), [3, 4]);
  });

  test("forking straight after a thought that requested a tool is refused", () => {
    const result = checkForkPoint(TRACE, 1);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /middle of a model turn/);
  });
});

describe("replay", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg();
  });

  /**
   * Several tests create a replay without advancing it. Leaving those `queued`
   * would let the next test's `claimNextRun` pick one up instead of its own
   * run, which is a baffling way for an unrelated assertion to fail.
   */
  afterEach(async () => {
    await db
      .update(runs)
      .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
      .where(scoped(runs, scope, inArray(runs.status, ["queued", "running"])));
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  async function completedRun(toolKeys: string[]) {
    const { versionId } = await createConfiguredAgent(scope, { toolKeys });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "original task",
    });
    const claimed = await claimNextRun(`w-${id.slice(0, 6)}`);
    assert.equal(claimed?.id, id);
    await advanceRun(id, `w-${id.slice(0, 6)}`);
    return id;
  }

  test("forking copies the prefix and leaves the source untouched", async () => {
    const sourceId = await completedRun(["calculator", "web_search"]);
    const sourceSteps = await loadSteps(sourceId);
    const forkAt = eligibleForkOrdinals(sourceSteps)[0];

    const replay = await replayRun(scope, sourceId, forkAt);
    const copied = await loadSteps(replay.id);

    assert.equal(copied.length, forkAt, "one row per copied ordinal");
    assert.ok(
      copied.every((s) => s.ordinal < forkAt),
      "nothing at or past the fork point is copied",
    );

    // Immutability: the source trace is identical afterwards.
    const sourceAfter = await loadSteps(sourceId);
    assert.deepEqual(
      sourceAfter.map((s) => s.id),
      sourceSteps.map((s) => s.id),
    );
  });

  test("the replay records its provenance and pins the same agent version", async () => {
    const sourceId = await completedRun(["calculator"]);
    const forkAt = eligibleForkOrdinals(await loadSteps(sourceId))[0];

    const replay = await replayRun(scope, sourceId, forkAt);

    const [source] = await db.select().from(runs).where(eq(runs.id, sourceId));
    const [forked] = await db.select().from(runs).where(eq(runs.id, replay.id));

    assert.equal(forked.replayedFromRunId, sourceId);
    assert.equal(forked.replayedFromStepOrdinal, forkAt);
    assert.equal(forked.agentVersionId, source.agentVersionId);
    assert.equal(forked.status, "queued");
  });

  test("the loop continues from the fork point rather than restarting", async () => {
    const sourceId = await completedRun(["calculator", "web_search"]);
    const forkAt = eligibleForkOrdinals(await loadSteps(sourceId))[0];

    const replay = await replayRun(scope, sourceId, forkAt);

    // next_ordinal is what makes the machine append rather than collide.
    const [queued] = await db.select().from(runs).where(eq(runs.id, replay.id));
    assert.equal(queued.nextOrdinal, forkAt);

    const claimed = await claimNextRun("replay-worker");
    assert.equal(claimed?.id, replay.id);
    await advanceRun(replay.id, "replay-worker");

    const [finished] = await db.select().from(runs).where(eq(runs.id, replay.id));
    assert.equal(finished.status, "completed");

    const steps = await loadSteps(replay.id);
    const ordinals = steps.map((s) => s.ordinal);
    assert.deepEqual(
      ordinals,
      ordinals.map((_, i) => i),
      "ordinals stay contiguous across the copied prefix and the new steps",
    );
    assert.ok(
      steps.length > forkAt,
      "new steps were appended after the copied prefix",
    );
  });

  test("the copied prefix reconstructs a well-formed conversation", async () => {
    const sourceId = await completedRun(["calculator", "web_search"]);
    const forkAt = eligibleForkOrdinals(await loadSteps(sourceId))[0];
    const replay = await replayRun(scope, sourceId, forkAt);

    const history = buildHistory("original task", await loadSteps(replay.id));

    assert.equal(history[0].role, "user");

    // The invariant the fork-point check exists to guarantee: every tool_use
    // the assistant asked for has a matching tool_result somewhere after it.
    const requested = new Set<string>();
    const answered = new Set<string>();

    for (const entry of history) {
      if (entry.role === "assistant") {
        for (const block of entry.content as Array<{ type?: string; id?: string }>) {
          if (block?.type === "tool_use" && block.id) requested.add(block.id);
        }
      } else if (entry.role === "tool_results") {
        for (const r of entry.results) answered.add(r.toolUseId);
      }
    }

    for (const id of requested) {
      assert.ok(answered.has(id), `tool_use ${id} has no result in the replay`);
    }
  });

  test("replay cost starts at zero so spend is not double-counted", async () => {
    const sourceId = await completedRun(["calculator"]);
    const forkAt = eligibleForkOrdinals(await loadSteps(sourceId))[0];

    const replay = await replayRun(scope, sourceId, forkAt);
    const [before] = await db.select().from(runs).where(eq(runs.id, replay.id));

    assert.equal(Number(before.costUsd), 0);
    assert.equal(before.tokensIn, 0);

    // The copied steps still carry what they originally cost, so the two
    // numbers stay reconcilable.
    const copied = await loadSteps(replay.id);
    assert.ok(copied.some((s) => Number(s.costUsd) > 0));
  });

  test("forking mid-turn is refused against a real run", async () => {
    const sourceId = await completedRun(["calculator"]);
    const steps = await loadSteps(sourceId);
    const toolCall = steps.find((s) => s.type === "tool_call")!;

    // The ordinal immediately after a tool_call is its result, so cutting there
    // would orphan the call.
    await assert.rejects(
      () => replayRun(scope, sourceId, toolCall.ordinal + 1),
      /middle of a model turn/,
    );
  });

  test("a side-effecting call in the prefix is copied, not re-executed", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "email then continue",
    });

    await claimNextRun("se-w1");
    await advanceRun(id, "se-w1");
    const approval = (await loadSteps(id)).find((s) => s.type === "approval")!;
    await resolveApproval(scope, approval.id, { decision: "approve" });
    await claimNextRun("se-w2");
    await advanceRun(id, "se-w2");

    const sourceSteps = await loadSteps(id);
    const emailResult = sourceSteps.find(
      (s) => s.type === "tool_result" && s.label.startsWith("send_email"),
    )!;
    assert.ok(emailResult, "the source run did send the email");

    // Fork past the email. Because the prefix is copied rather than replayed,
    // the email is not sent a second time — this is the whole reason forking
    // beats re-running from scratch.
    const forkAt = eligibleForkOrdinals(sourceSteps).find(
      (o) => o > emailResult.ordinal,
    )!;
    const replay = await replayRun(scope, id, forkAt);

    const copied = await loadSteps(replay.id);
    const copiedEmail = copied.filter(
      (s) => s.type === "tool_result" && s.label.startsWith("send_email"),
    );

    assert.equal(copiedEmail.length, 1, "exactly one email result, the copy");
    assert.notEqual(
      copiedEmail[0].id,
      emailResult.id,
      "it is a new row, not the source row",
    );
    assert.deepEqual(
      copiedEmail[0].result,
      emailResult.result,
      "with the recorded outcome preserved",
    );
  });

  test("a run in another organization cannot be replayed", async () => {
    const other = await createTestOrg();
    try {
      const sourceId = await completedRun(["calculator"]);
      const forkAt = eligibleForkOrdinals(await loadSteps(sourceId))[0];

      await assert.rejects(
        () => replayRun(other, sourceId, forkAt),
        /not found/,
      );
    } finally {
      await destroyTestOrg(other);
    }
  });
});
