import "server-only";
import { desc, eq, gte, inArray, sql } from "drizzle-orm";
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

export type VersionRow = {
  id: string;
  versionNo: number;
  model: string;
  systemInstructions: string;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  requireApprovalForSideEffecting: boolean;
  createdAt: Date;
  archivedAt: Date | null;
  isProduction: boolean;
  runCount: number;
  toolKeys: string[];
};

/**
 * Versions with the two facts that make the list worth reading: whether a
 * version is in production, and how many runs actually exercised it. A version
 * with no runs behind it has no evidence behind it either.
 */
export async function agentVersionList(agentId: string): Promise<VersionRow[]> {
  const scope = await currentScope();

  const [agent] = await db
    .select({ productionVersionId: agents.productionVersionId })
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent) return [];

  const versions = await db
    .select()
    .from(agentVersions)
    .where(scoped(agentVersions, scope, eq(agentVersions.agentId, agentId)))
    .orderBy(desc(agentVersions.versionNo));

  if (versions.length === 0) return [];

  const ids = versions.map((v) => v.id);

  const counts = await db
    .select({
      agentVersionId: runs.agentVersionId,
      n: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(scoped(runs, scope, inArray(runs.agentVersionId, ids)))
    .groupBy(runs.agentVersionId);

  const countByVersion = new Map(counts.map((c) => [c.agentVersionId, c.n]));

  const attachments = await db
    .select({
      agentVersionId: agentVersionTools.agentVersionId,
      key: toolDefinitions.key,
    })
    .from(agentVersionTools)
    .innerJoin(
      toolDefinitions,
      eq(agentVersionTools.toolDefinitionId, toolDefinitions.id),
    )
    .where(inArray(agentVersionTools.agentVersionId, ids));

  const toolsByVersion = new Map<string, string[]>();
  for (const row of attachments) {
    const list = toolsByVersion.get(row.agentVersionId) ?? [];
    list.push(row.key);
    toolsByVersion.set(row.agentVersionId, list);
  }

  return versions.map((v) => ({
    id: v.id,
    versionNo: v.versionNo,
    model: v.model,
    systemInstructions: v.systemInstructions,
    maxSteps: v.maxSteps,
    timeoutMs: v.timeoutMs,
    maxRetries: v.maxRetries,
    requireApprovalForSideEffecting: v.requireApprovalForSideEffecting,
    createdAt: v.createdAt,
    archivedAt: v.archivedAt,
    isProduction: v.id === agent.productionVersionId,
    runCount: countByVersion.get(v.id) ?? 0,
    toolKeys: toolsByVersion.get(v.id) ?? [],
  }));
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
