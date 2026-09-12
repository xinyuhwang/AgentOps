/**
 * Print a run's trace to the terminal — the same data the Phase 1 trace UI
 * renders, useful for confirming the engine before the UI exists.
 *
 *   pnpm trace <runId>
 *   pnpm trace            # most recent run
 */
import { desc, eq } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { runs } from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";
import { loadSteps } from "@/core/run/store";

async function main() {
  const scope = await currentScope();
  const wanted = process.argv[2];

  const [run] = await db
    .select()
    .from(runs)
    .where(wanted ? scoped(runs, scope, eq(runs.id, wanted)) : scoped(runs, scope))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  if (!run) {
    console.error("No runs found.");
    process.exit(1);
  }

  console.log(`\nrun ${run.id}`);
  console.log(`status   ${run.status}${run.errorType ? ` (${run.errorType}: ${run.errorDetail})` : ""}`);
  console.log(`duration ${run.durationMs ?? "-"}ms   tokens ${run.tokensIn}/${run.tokensOut}   cost $${Number(run.costUsd).toFixed(6)}`);
  console.log(`output   ${JSON.stringify(run.output)}\n`);

  for (const step of await loadSteps(run.id)) {
    const attempt = step.attempt > 1 ? ` attempt ${step.attempt}` : "";
    const state = step.approvalState ? ` [${step.approvalState}]` : "";
    const err = step.errorType ? `  !! ${step.errorType}: ${step.errorDetail}` : "";
    console.log(
      `  ${String(step.ordinal).padStart(2)}${attempt.padEnd(11)} ${step.type.padEnd(12)} ${step.label}${state}${err}`,
    );
  }
  console.log();
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
