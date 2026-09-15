import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, steps } from "@/db/schema";
import type { Scope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";
import { resolveApproval } from "@/core/run/approvals";
import { loadSteps } from "@/core/run/store";
import {
  closeDb,
  createConfiguredAgent,
  createTestOrg,
  destroyTestOrg,
} from "@/test/helpers";

after(closeDb);

/**
 * Engine behaviour against a real database. These run with the deterministic
 * scripted provider (LLM_PROVIDER defaults to `fake`), which decides its next
 * move purely from the history handed to it — so a resumed run produces the
 * same next request a crashed worker would have.
 */
async function runToStop(runId: string, workerId: string) {
  const claimed = await claimNextRun(workerId);
  assert.equal(claimed?.id, runId, "expected to claim the run under test");
  await advanceRun(runId, workerId);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  return run;
}

describe("run engine", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg();
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  test("a run with no side-effecting tools completes end to end", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator", "web_search"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Add some numbers",
    });

    const run = await runToStop(id, "w1");

    assert.equal(run.status, "completed");
    assert.ok(run.durationMs !== null, "duration is recorded");
    assert.ok(Number(run.costUsd) > 0, "cost is accumulated onto the run");
    assert.equal(run.leaseOwner, null, "a finished run holds no lease");

    const persisted = await loadSteps(id);
    assert.equal(persisted.at(-1)?.type, "completion");
    assert.ok(persisted.some((s) => s.type === "tool_call"));
    assert.ok(persisted.some((s) => s.type === "tool_result"));
  });

  test("step ordinals are contiguous and start at zero", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "One tool",
    });

    await runToStop(id, "w2");

    const ordinals = (await loadSteps(id)).map((s) => s.ordinal);
    assert.deepEqual(
      ordinals,
      ordinals.map((_, i) => i),
    );
  });

  test("a side-effecting tool suspends the run and releases the lease", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
      requireApprovalForSideEffecting: true,
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Email ops",
    });

    const run = await runToStop(id, "w3");

    assert.equal(run.status, "awaiting_approval");
    assert.equal(run.leaseOwner, null, "a suspended run must not hold a worker");
    assert.equal(run.leaseExpiresAt, null);

    const persisted = await loadSteps(id);
    const approval = persisted.find((s) => s.type === "approval");
    assert.equal(approval?.approvalState, "pending");
    assert.ok(
      !persisted.some((s) => s.type === "tool_result"),
      "nothing was sent before approval",
    );
  });

  test("approval turns the gate off and a different worker finishes the run", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Email ops again",
    });

    await runToStop(id, "w4");
    const before = await loadSteps(id);

    const approval = before.find((s) => s.type === "approval")!;
    await resolveApproval(scope, approval.id, { decision: "approve" });

    const [queued] = await db.select().from(runs).where(eq(runs.id, id));
    assert.equal(queued.status, "queued", "approval re-queues rather than running");

    // A different worker, with no memory of the first.
    const run = await runToStop(id, "w5");

    assert.equal(run.status, "completed");

    const after = await loadSteps(id);
    assert.ok(after.length > before.length, "it continued");
    assert.equal(
      after.filter((s) => s.ordinal === 0).length,
      1,
      "it did not restart from the beginning",
    );
    assert.ok(
      after.some((s) => s.type === "tool_result" && s.label.startsWith("send_email")),
      "the approved call actually ran",
    );
  });

  test("rejecting an approval fails the run with approval_rejected", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Email nobody",
    });

    await runToStop(id, "w6");
    const approval = (await loadSteps(id)).find((s) => s.type === "approval")!;
    await resolveApproval(scope, approval.id, { decision: "reject" });

    const run = await runToStop(id, "w7");

    assert.equal(run.status, "failed");
    assert.equal(run.errorType, "approval_rejected");
    assert.ok(
      !(await loadSteps(id)).some((s) => s.type === "tool_result"),
      "a rejected call never executes",
    );
  });

  test("an approval cannot be resolved twice", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["send_email"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Double decide",
    });

    await runToStop(id, "w8");
    const approval = (await loadSteps(id)).find((s) => s.type === "approval")!;

    await resolveApproval(scope, approval.id, { decision: "approve" });
    await assert.rejects(
      () => resolveApproval(scope, approval.id, { decision: "reject" }),
      /already been resolved/,
    );

    // Approving re-queued this run. Leaving it claimable would let it be picked
    // up by the next test's claim, which is a confusing way for an unrelated
    // assertion to fail.
    await db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, id));
  });

  test("an approval belonging to another organization is not visible", async () => {
    const other = await createTestOrg();
    try {
      const { versionId } = await createConfiguredAgent(scope, {
        toolKeys: ["send_email"],
      });
      const { id } = await enqueueRun(scope, {
        agentVersionId: versionId,
        task: "Tenant check",
      });
      await runToStop(id, "w9");
      const approval = (await loadSteps(id)).find((s) => s.type === "approval")!;

      await assert.rejects(
        () => resolveApproval(other, approval.id, { decision: "approve" }),
        /not found/,
      );
    } finally {
      await destroyTestOrg(other);
    }
  });

  test("hitting max steps fails the run rather than looping forever", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator", "web_search", "database_query"],
      maxSteps: 2,
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Never finish",
    });

    const run = await runToStop(id, "w10");

    assert.equal(run.status, "failed");
    assert.equal(run.errorType, "max_steps_exceeded");
  });

  test("every persisted step carries the run's organization", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Tenancy",
    });
    await runToStop(id, "w11");

    const rows = await db.select().from(steps).where(eq(steps.runId, id));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((s) => s.organizationId === scope.organizationId));
  });
});

describe("run claiming", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg(1);
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  test("an expired lease is reclaimed and a live one is not", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Orphan",
    });

    // Exactly the state a killed worker leaves behind.
    await db
      .update(runs)
      .set({
        status: "running",
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(runs.id, id));

    const reclaimed = await claimNextRun("rescuer");
    assert.equal(reclaimed?.id, id);

    await db
      .update(runs)
      .set({
        status: "running",
        leaseOwner: "alive-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, id));

    const stolen = await claimNextRun("thief");
    assert.notEqual(stolen?.id, id, "a live lease must not be stealable");

    await db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, id));
  });

  test("the per-organization concurrency cap holds", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });

    const first = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "One",
    });
    const second = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Two",
    });

    // The org was created with maxConcurrentRuns = 1.
    const a = await claimNextRun("cap-worker-a");
    assert.equal(a?.id, first.id);

    const b = await claimNextRun("cap-worker-b");
    assert.equal(b, null, "the second run waits rather than starving the pool");

    await db
      .update(runs)
      .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(runs.id, first.id));

    const c = await claimNextRun("cap-worker-c");
    assert.equal(c?.id, second.id, "it becomes claimable once capacity frees up");

    await db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, second.id));
  });
});
