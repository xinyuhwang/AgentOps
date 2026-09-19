import assert from "node:assert/strict";
import test, { after, afterEach, before, describe } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { runs } from "@/db/schema";
import { scoped, type Scope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";
import {
  createWorkflowFromRun,
  getWorkflow,
  listWorkflows,
  runWorkflow,
} from "./service";
import {
  closeDb,
  createConfiguredAgent,
  createTestOrg,
  destroyTestOrg,
} from "@/test/helpers";

after(closeDb);

describe("workflows", () => {
  let scope: Scope;

  before(async () => {
    scope = await createTestOrg();
  });

  afterEach(async () => {
    // Workflow runs are enqueued but rarely advanced here; leaving them
    // claimable would hand them to the next test's `claimNextRun`.
    await db
      .update(runs)
      .set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null })
      .where(scoped(runs, scope, inArray(runs.status, ["queued", "running"])));
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  async function completedRun() {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "Check refund status for order 1182",
    });
    const worker = `wf-${id.slice(0, 6)}`;
    const claimed = await claimNextRun(worker);
    assert.equal(claimed?.id, id);
    await advanceRun(id, worker);
    return { runId: id, versionId };
  }

  test("a completed run can be captured with a parameterised template", async () => {
    const { runId, versionId } = await completedRun();

    const workflow = await createWorkflowFromRun(scope, runId, {
      name: "Refund status check",
      template: "Check refund status for order {{order_id}}",
    });

    const detail = await getWorkflow(scope, workflow.id);
    assert.ok(detail);
    assert.equal(detail.name, "Refund status check");
    assert.equal(detail.sourceRunId, runId);
    // Pinned to the version that produced the original run.
    assert.equal(detail.agentVersionId, versionId);
    assert.deepEqual(detail.spec.variables, ["order_id"]);
  });

  test("an unfinished run cannot be saved as a workflow", async () => {
    const { versionId } = await createConfiguredAgent(scope, {
      toolKeys: ["calculator"],
    });
    const { id } = await enqueueRun(scope, {
      agentVersionId: versionId,
      task: "still queued",
    });

    await assert.rejects(
      () =>
        createWorkflowFromRun(scope, id, {
          name: "Too early",
          template: "anything",
        }),
      /completed run/,
    );
  });

  test("a workflow needs a name and a template", async () => {
    const { runId } = await completedRun();

    await assert.rejects(
      () => createWorkflowFromRun(scope, runId, { name: "  ", template: "x" }),
      /needs a name/,
    );
    await assert.rejects(
      () => createWorkflowFromRun(scope, runId, { name: "x", template: "  " }),
      /task template/,
    );
  });

  test("running a workflow renders the task and pins the version", async () => {
    const { runId, versionId } = await completedRun();
    const workflow = await createWorkflowFromRun(scope, runId, {
      name: "Refund status check",
      template: "Check refund status for order {{order_id}}",
    });

    const result = await runWorkflow(scope, workflow.id, { order_id: "9001" });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));

    assert.deepEqual(run.input, {
      task: "Check refund status for order 9001",
    });
    assert.equal(run.agentVersionId, versionId);
    assert.equal(run.workflowId, workflow.id);
    // Queued, not executed — a worker picks it up like any other run.
    assert.equal(run.status, "queued");
  });

  test("invalid input produces errors and no run", async () => {
    const { runId } = await completedRun();
    const workflow = await createWorkflowFromRun(scope, runId, {
      name: "Refund status check",
      template: "Check refund status for order {{order_id}}",
    });

    const before = await db
      .select({ id: runs.id })
      .from(runs)
      .where(scoped(runs, scope, eq(runs.workflowId, workflow.id)));

    const result = await runWorkflow(scope, workflow.id, {});
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.errors[0] : "", /Missing required/);

    const after = await db
      .select({ id: runs.id })
      .from(runs)
      .where(scoped(runs, scope, eq(runs.workflowId, workflow.id)));

    assert.equal(after.length, before.length, "no run was enqueued");
  });

  test("a workflow run reaches completion through the ordinary loop", async () => {
    const { runId } = await completedRun();
    const workflow = await createWorkflowFromRun(scope, runId, {
      name: "End to end",
      template: "Check refund status for order {{order_id}}",
    });

    const result = await runWorkflow(scope, workflow.id, { order_id: "42" });
    assert.ok(result.ok);
    if (!result.ok) return;

    const claimed = await claimNextRun("wf-runner");
    assert.equal(claimed?.id, result.runId);
    await advanceRun(result.runId, "wf-runner");

    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));
    assert.equal(run.status, "completed");

    const detail = await getWorkflow(scope, workflow.id);
    assert.equal(detail?.runCount, 1);
  });

  test("a workflow in another organization is invisible", async () => {
    const other = await createTestOrg();
    try {
      const { runId } = await completedRun();
      const workflow = await createWorkflowFromRun(scope, runId, {
        name: "Theirs",
        template: "Check {{order_id}}",
      });

      assert.equal(await getWorkflow(other, workflow.id), null);

      const result = await runWorkflow(other, workflow.id, { order_id: "1" });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.errors[0] : "", /not found/);

      assert.equal(
        (await listWorkflows(other)).length,
        0,
        "the list is scoped too",
      );
    } finally {
      await destroyTestOrg(other);
    }
  });

  test("a run from another organization cannot be captured", async () => {
    const other = await createTestOrg();
    try {
      const { runId } = await completedRun();
      await assert.rejects(
        () =>
          createWorkflowFromRun(other, runId, {
            name: "Nope",
            template: "x",
          }),
        /not found/,
      );
    } finally {
      await destroyTestOrg(other);
    }
  });
});
