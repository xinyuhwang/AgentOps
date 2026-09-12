import "server-only";
import { desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  agentVersionTools,
  agentVersions,
  agents,
  runs,
  toolDefinitions,
} from "@/db/schema";
import { currentScope, scoped } from "@/db/scope";

/** §9 — metric windows are stated, not implicit. */
export const METRIC_WINDOW_DAYS = 30;

function windowStart(): Date {
  return new Date(Date.now() - METRIC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export async function listAgents() {
  const scope = await currentScope();

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      productionVersionId: agents.productionVersionId,
      model: agentVersions.model,
      versionNo: agentVersions.versionNo,
    })
    .from(agents)
    .leftJoin(agentVersions, eq(agents.productionVersionId, agentVersions.id))
    .where(scoped(agents, scope))
    .orderBy(agents.name);

  // One aggregate pass rather than a query per agent.
  const stats = await db
    .select({
      agentId: agentVersions.agentId,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${runs.status} = 'completed')::int`,
      lastRunAt: sql<Date | null>`max(${runs.createdAt})`,
    })
    .from(runs)
    .innerJoin(agentVersions, eq(runs.agentVersionId, agentVersions.id))
    .where(scoped(runs, scope, gte(runs.createdAt, windowStart())))
    .groupBy(agentVersions.agentId);

  const byAgent = new Map(stats.map((s) => [s.agentId, s]));

  return rows.map((row) => {
    const stat = byAgent.get(row.id);
    return {
      ...row,
      // Deliberately not called "success rate": with no ground truth behind a
      // production run, completion is the only honest thing to report (§3.4).
      completionRate:
        stat && stat.total > 0 ? stat.completed / stat.total : null,
      runCount: stat?.total ?? 0,
      lastRunAt: stat?.lastRunAt ?? null,
      status: row.productionVersionId ? ("production" as const) : ("draft" as const),
    };
  });
}

export async function recentRuns(limit = 12) {
  const scope = await currentScope();

  return db
    .select({
      id: runs.id,
      label: runs.label,
      status: runs.status,
      durationMs: runs.durationMs,
      costUsd: runs.costUsd,
      createdAt: runs.createdAt,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(runs)
    .innerJoin(agentVersions, eq(runs.agentVersionId, agentVersions.id))
    .innerJoin(agents, eq(agentVersions.agentId, agents.id))
    .where(scoped(runs, scope))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

export async function getAgent(agentId: string) {
  const scope = await currentScope();

  const [agent] = await db
    .select()
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent) return null;

  const versions = await db
    .select()
    .from(agentVersions)
    .where(scoped(agentVersions, scope, eq(agentVersions.agentId, agentId)))
    .orderBy(desc(agentVersions.versionNo));

  const production =
    versions.find((v) => v.id === agent.productionVersionId) ?? versions[0];

  const attached: Array<{ id: string }> = production
    ? await db
        .select({ id: toolDefinitions.id })
        .from(agentVersionTools)
        .innerJoin(
          toolDefinitions,
          eq(agentVersionTools.toolDefinitionId, toolDefinitions.id),
        )
        .where(eq(agentVersionTools.agentVersionId, production.id))
    : [];

  const allTools = await db
    .select()
    .from(toolDefinitions)
    .orderBy(toolDefinitions.displayName);

  return {
    agent,
    versions,
    production,
    allTools,
    attachedToolIds: new Set(attached.map((a) => a.id)),
  };
}

export async function agentRuns(agentId: string, limit = 50) {
  const scope = await currentScope();

  return db
    .select({
      id: runs.id,
      label: runs.label,
      status: runs.status,
      durationMs: runs.durationMs,
      costUsd: runs.costUsd,
      createdAt: runs.createdAt,
      versionNo: agentVersions.versionNo,
    })
    .from(runs)
    .innerJoin(agentVersions, eq(runs.agentVersionId, agentVersions.id))
    .where(scoped(runs, scope, eq(agentVersions.agentId, agentId)))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}
