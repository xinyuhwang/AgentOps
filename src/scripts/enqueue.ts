/**
 * Queue a run from the command line.
 *
 *   pnpm enqueue "Check refund status for order 1182"
 *   pnpm enqueue "Email the customer a summary" --agent "Support triage"
 *
 * Queuing and executing are separate on purpose — this writes a row and exits.
 * Start `pnpm worker` to watch it get picked up.
 */
import { and, eq } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { agentVersions, agents } from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";
import { enqueueRun } from "@/core/run/create";

async function main() {
  const args = process.argv.slice(2);
  const agentFlag = args.indexOf("--agent");
  const agentName = agentFlag >= 0 ? args[agentFlag + 1] : null;
  const task = args.filter((a, i) => {
    if (a === "--agent") return false;
    if (agentFlag >= 0 && i === agentFlag + 1) return false;
    return !a.startsWith("--");
  })[0];

  if (!task) {
    console.error('Usage: pnpm enqueue "<task>" [--agent "<name>"]');
    process.exit(1);
  }

  const scope = await currentScope();

  const rows = await db
    .select({ versionId: agentVersions.id, agentName: agents.name })
    .from(agents)
    .innerJoin(
      agentVersions,
      eq(agents.productionVersionId, agentVersions.id),
    )
    .where(
      agentName
        ? scoped(agents, scope, eq(agents.name, agentName))
        : scoped(agents, scope),
    )
    .limit(1);

  if (rows.length === 0) {
    console.error(
      agentName
        ? `No agent named "${agentName}" with a production version.`
        : "No agents with a production version. Run `pnpm db:seed`.",
    );
    process.exit(1);
  }

  const run = await enqueueRun(scope, {
    agentVersionId: rows[0].versionId,
    task,
  });

  console.log(`queued run ${run.id} on "${rows[0].agentName}"`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
