import { sql as rawSql } from "@/db/client";

export const LEASE_MS = 30_000;

export type ClaimedRun = {
  id: string;
  organization_id: string;
  agent_version_id: string;
  input: { task?: string } & Record<string, unknown>;
};

/**
 * Claims one run for this worker, atomically.
 *
 * Three things happen in this single statement, and each matters:
 *   - `status = 'queued' OR (running AND lease expired)` is crash recovery. A
 *     worker that dies mid-run leaves a `running` row whose lease stops being
 *     renewed; once it expires another worker takes over and resumes from the
 *     last persisted step.
 *   - `FOR UPDATE SKIP LOCKED` lets several workers poll the same table
 *     without handing the same run to two of them.
 *   - The correlated count enforces the per-organization concurrency cap
 *     (§7.8) at claim time, so one busy workspace cannot starve the pool.
 */
export async function claimNextRun(
  workerId: string,
): Promise<ClaimedRun | null> {
  const rows = await rawSql<ClaimedRun[]>`
    UPDATE runs
    SET status = 'running',
        lease_owner = ${workerId},
        lease_expires_at = now() + (${LEASE_MS} || ' milliseconds')::interval,
        started_at = COALESCE(runs.started_at, now())
    WHERE runs.id = (
      SELECT r.id
      FROM runs r
      JOIN organizations o ON o.id = r.organization_id
      WHERE (
              r.status = 'queued'
              OR (r.status = 'running' AND r.lease_expires_at < now())
            )
        AND (
              SELECT count(*)
              FROM runs busy
              WHERE busy.organization_id = r.organization_id
                AND busy.status = 'running'
                AND busy.lease_expires_at > now()
            ) < o.max_concurrent_runs
      ORDER BY r.created_at
      FOR UPDATE OF r SKIP LOCKED
      LIMIT 1
    )
    RETURNING runs.id, runs.organization_id, runs.agent_version_id, runs.input;
  `;

  return rows[0] ?? null;
}
