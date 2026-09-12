/**
 * Phase 1 acceptance check.
 *
 * Phase 1's whole claim is that the execution core is durable — that suspend,
 * resume and crash recovery work *now*, so Phases 2-3 add capability instead of
 * rewriting the loop. This script proves that claim against a real database
 * rather than asserting it in a design doc:
 *
 *   A. a side-effecting tool suspends the run on an approval, and the worker
 *      lets go of it rather than blocking;
 *   B. a different worker, with no memory of the first, resumes mid-run from
 *      persisted state and finishes;
 *   C. a run whose worker died is reclaimable once its lease expires;
 *   D. tool failures are classified, not flattened.
 *
 *   pnpm verify
 */
import { eq, sql as raw } from "drizzle-orm";
import { db, sql } from "@/db/client";
import {
  agentVersionTools,
  agentVersions,
  agents,
  runs,
  toolDefinitions,
} from "@/db/schema";
import { currentScope } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";
import { resolveApproval } from "@/core/run/approvals";
import { loadSteps } from "@/core/run/store";
import { dispatchTool } from "@/core/tools/dispatcher";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const scope = await currentScope();

  // An agent whose toolset includes the one side-effecting built-in.
  const [agent] = await db
    .insert(agents)
    .values({
      organizationId: scope.organizationId,
      name: `Verify notifier ${Date.now()}`,
      description: "Fixture for the Phase 1 acceptance check.",
    })
    .returning();

  const [version] = await db
    .insert(agentVersions)
    .values({
      organizationId: scope.organizationId,
      agentId: agent.id,
      versionNo: 1,
      model: "claude-opus-5",
      systemInstructions: "Notify operations when something needs attention.",
      maxSteps: 6,
      requireApprovalForSideEffecting: true,
    })
    .returning();

  await db
    .update(agents)
    .set({ productionVersionId: version.id })
    .where(eq(agents.id, agent.id));

  const tools = await db
    .select()
    .from(toolDefinitions)
    .where(eq(toolDefinitions.key, "send_email"));

  await db
    .insert(agentVersionTools)
    .values({ agentVersionId: version.id, toolDefinitionId: tools[0].id });

  /* ---------------------------------------------------------------- A --- */
  console.log("\nA. side-effecting tool suspends the run");

  const run = await enqueueRun(scope, {
    agentVersionId: version.id,
    task: "Tell ops the nightly job failed",
  });

  const claimedA = await claimNextRun("worker-A");
  check("worker A claims the queued run", claimedA?.id === run.id);
  await advanceRun(run.id, "worker-A");

  const [afterA] = await db.select().from(runs).where(eq(runs.id, run.id));
  const stepsA = await loadSteps(run.id);
  const approval = stepsA.find((s) => s.type === "approval");

  check("run is awaiting_approval", afterA.status === "awaiting_approval", afterA.status);
  check("a pending approval step exists", approval?.approvalState === "pending");
  check(
    "the worker released its lease",
    afterA.leaseOwner === null && afterA.leaseExpiresAt === null,
  );
  check("no email was sent before approval", !stepsA.some((s) => s.type === "tool_result"));

  /* ---------------------------------------------------------------- B --- */
  console.log("\nB. a different worker resumes mid-run");

  const ordinalsBefore = stepsA.length;
  await resolveApproval(scope, approval!.id, { decision: "approve" });

  const [queued] = await db.select().from(runs).where(eq(runs.id, run.id));
  check("approval re-queues the run", queued.status === "queued", queued.status);

  const claimedB = await claimNextRun("worker-B");
  check("worker B claims it", claimedB?.id === run.id);
  await advanceRun(run.id, "worker-B");

  const [afterB] = await db.select().from(runs).where(eq(runs.id, run.id));
  const stepsB = await loadSteps(run.id);
  const emailResult = stepsB.find(
    (s) => s.type === "tool_result" && s.label.startsWith("send_email"),
  );

  check("run completed", afterB.status === "completed", afterB.status);
  check("the approved email actually ran", Boolean(emailResult));
  check(
    "worker B continued rather than restarting",
    stepsB.length > ordinalsBefore &&
      stepsB.filter((s) => s.ordinal === 0).length === 1,
    `${ordinalsBefore} steps before, ${stepsB.length} after`,
  );
  check("cost was accumulated onto the run", Number(afterB.costUsd) > 0, `$${afterB.costUsd}`);

  /* ---------------------------------------------------------------- C --- */
  console.log("\nC. a dead worker's run is reclaimable");

  const orphan = await enqueueRun(scope, {
    agentVersionId: version.id,
    task: "Orphaned run",
  });

  // Exactly the state a killed worker leaves behind: still `running`, lease
  // never renewed.
  await db
    .update(runs)
    .set({
      status: "running",
      leaseOwner: "worker-that-died",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    })
    .where(eq(runs.id, orphan.id));

  const reclaimed = await claimNextRun("worker-C");
  check("expired lease is reclaimed", reclaimed?.id === orphan.id);

  // And the inverse: a live lease must NOT be stealable.
  await db
    .update(runs)
    .set({
      status: "running",
      leaseOwner: "worker-alive",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, orphan.id));

  const stolen = await claimNextRun("worker-D");
  check("a live lease is not stolen", stolen?.id !== orphan.id);

  await db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, orphan.id));

  /* ---------------------------------------------------------------- D --- */
  console.log("\nD. tool failures are classified, not flattened");

  const unknown = await dispatchTool("no_such_tool", {}, {
    timeoutMs: 1000,
    maxRetries: 2,
  });
  check("unknown tool -> tool_error", unknown.errorType === "tool_error");
  check("unknown tool is not retried", unknown.attempts === 1, `${unknown.attempts} attempt(s)`);

  const badArgs = await dispatchTool("calculator", { expression: "drop table users" }, {
    timeoutMs: 1000,
    maxRetries: 2,
  });
  check("bad arguments -> tool_error", badArgs.errorType === "tool_error");
  check(
    "bad arguments are not retried",
    badArgs.attempts === 1,
    `${badArgs.attempts} attempt(s)`,
  );

  const good = await dispatchTool("calculator", { expression: "(3 + 4) * 2" }, {
    timeoutMs: 1000,
    maxRetries: 2,
  });
  check("a good call succeeds", good.ok && good.result?.value === 14);

  /* --------------------------------------------------------------------- */
  console.log(
    failures === 0
      ? "\nall checks passed\n"
      : `\n${failures} check(s) failed\n`,
  );

  await db.delete(runs).where(raw`${runs.agentVersionId} = ${version.id}`);
  await db.delete(agents).where(eq(agents.id, agent.id));
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
