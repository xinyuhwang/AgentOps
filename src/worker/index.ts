import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { claimNextRun } from "@/core/run/claim";
import { advanceRun } from "@/core/run/machine";

/**
 * The worker. Claim a run, advance it to a stopping point, repeat.
 *
 * Deliberately dumb: all the recovery logic lives in the claim query and the
 * state machine, so running two of these is a matter of starting the process
 * twice — `FOR UPDATE SKIP LOCKED` sorts out who gets what.
 */

const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const IDLE_POLL_MS = 500;
const runOnce = process.argv.includes("--once");

let shuttingDown = false;

async function loop() {
  console.log(`[${WORKER_ID}] started${runOnce ? " (single pass)" : ""}`);

  while (!shuttingDown) {
    let claimed;
    try {
      claimed = await claimNextRun(WORKER_ID);
    } catch (err) {
      console.error(`[${WORKER_ID}] claim failed:`, err);
      await sleep(2000);
      continue;
    }

    if (!claimed) {
      if (runOnce) break;
      await sleep(IDLE_POLL_MS);
      continue;
    }

    console.log(`[${WORKER_ID}] advancing run ${claimed.id}`);
    try {
      await advanceRun(claimed.id, WORKER_ID);
    } catch (err) {
      // advanceRun already marks the run failed; this is a last-resort guard so
      // one bad run cannot take the worker down with it.
      console.error(`[${WORKER_ID}] run ${claimed.id} threw:`, err);
    }

    if (runOnce) break;
  }

  console.log(`[${WORKER_ID}] stopped`);
  await sql.end();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // No in-flight state to flush: whatever was persisted is the truth, and the
    // lease expiring hands the run to the next worker.
    console.log(`\n[${WORKER_ID}] ${signal} received, finishing current run`);
    shuttingDown = true;
  });
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
