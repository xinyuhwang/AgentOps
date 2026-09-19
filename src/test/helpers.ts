import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, sql } from "@/db/client";
import {
  agentVersionTools,
  agentVersions,
  agents,
  organizations,
  runs,
  steps,
  toolDefinitions,
  workflows,
} from "@/db/schema";
import type { Scope } from "@/db/scope";
import { BUILTIN_TOOLS } from "@/core/tools/builtin";

/**
 * Every test gets its own organization. That keeps tests independent without a
 * truncate-between-tests step, and it means the suite is also a standing check
 * that tenant scoping holds — a query that leaks across orgs shows up as a test
 * seeing rows it did not create.
 */
export async function createTestOrg(
  maxConcurrentRuns = 5,
): Promise<Scope & { slug: string }> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const [org] = await db
    .insert(organizations)
    .values({ name: `Test ${slug}`, slug, maxConcurrentRuns })
    .returning();
  return { organizationId: org.id, slug };
}

let poolClosed = false;

/**
 * Root `after` hooks fire once per test file but all run at the end of the
 * process, so closing the pool has to be idempotent — otherwise the second
 * caller tears down connections the first already released.
 */
export async function closeDb(): Promise<void> {
  if (poolClosed) return;
  poolClosed = true;
  await sql.end();
}

/**
 * Marks a version as "already produced a run" without leaving a claimable row
 * behind. A `queued` run would be picked up by whichever suite calls
 * `claimNextRun` next, which is a genuinely confusing way for an unrelated test
 * to fail.
 */
export async function recordCompletedRun(
  scope: Scope,
  agentVersionId: string,
): Promise<void> {
  await db.insert(runs).values({
    organizationId: scope.organizationId,
    agentVersionId,
    status: "completed",
    input: { task: "fixture" },
    endedAt: new Date(),
  });
}

/** Built-in tool rows are shared (organization_id is null), so seed once. */
export async function ensureBuiltinTools(): Promise<
  Map<string, { id: string; key: string }>
> {
  for (const tool of BUILTIN_TOOLS) {
    await db
      .insert(toolDefinitions)
      .values({
        organizationId: null,
        key: tool.key,
        version: tool.version,
        displayName: tool.displayName,
        description: tool.description,
        jsonSchema: tool.jsonSchema,
        sideEffecting: tool.sideEffecting,
        credentialRef: tool.credentialRef,
      })
      .onConflictDoNothing();
  }

  const rows = await db
    .select({ id: toolDefinitions.id, key: toolDefinitions.key })
    .from(toolDefinitions)
    .where(
      inArray(
        toolDefinitions.key,
        BUILTIN_TOOLS.map((t) => t.key),
      ),
    );

  return new Map(rows.map((r) => [r.key, r]));
}

export async function createConfiguredAgent(
  scope: Scope,
  params: {
    name?: string;
    toolKeys?: string[];
    maxSteps?: number;
    maxRetries?: number;
    timeoutMs?: number;
    requireApprovalForSideEffecting?: boolean;
  } = {},
): Promise<{ agentId: string; versionId: string }> {
  const tools = await ensureBuiltinTools();

  const [agent] = await db
    .insert(agents)
    .values({
      organizationId: scope.organizationId,
      name: params.name ?? `Agent ${randomUUID().slice(0, 6)}`,
    })
    .returning();

  const [version] = await db
    .insert(agentVersions)
    .values({
      organizationId: scope.organizationId,
      agentId: agent.id,
      versionNo: 1,
      model: "claude-opus-5",
      systemInstructions: "Test agent.",
      maxSteps: params.maxSteps ?? 8,
      maxRetries: params.maxRetries ?? 2,
      timeoutMs: params.timeoutMs ?? 15_000,
      requireApprovalForSideEffecting:
        params.requireApprovalForSideEffecting ?? true,
    })
    .returning();

  for (const key of params.toolKeys ?? []) {
    const tool = tools.get(key);
    if (!tool) throw new Error(`No built-in tool "${key}"`);
    await db
      .insert(agentVersionTools)
      .values({ agentVersionId: version.id, toolDefinitionId: tool.id });
  }

  await db
    .update(agents)
    .set({ productionVersionId: version.id })
    .where(eq(agents.id, agent.id));

  return { agentId: agent.id, versionId: version.id };
}

/**
 * Explicit teardown in dependency order. Relying on ON DELETE cascade from the
 * organization would be order-dependent here, because `runs.agent_version_id`
 * is RESTRICT — deliberately, so a version that produced a run cannot vanish.
 */
export async function destroyTestOrg(scope: Scope): Promise<void> {
  await db.delete(steps).where(eq(steps.organizationId, scope.organizationId));
  await db.delete(runs).where(eq(runs.organizationId, scope.organizationId));
  // Before agent_versions: `workflows.agent_version_id` is RESTRICT, so a
  // surviving workflow blocks the whole teardown.
  await db
    .delete(workflows)
    .where(eq(workflows.organizationId, scope.organizationId));

  const versions = await db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(eq(agentVersions.organizationId, scope.organizationId));

  if (versions.length > 0) {
    await db.delete(agentVersionTools).where(
      inArray(
        agentVersionTools.agentVersionId,
        versions.map((v) => v.id),
      ),
    );
  }

  await db
    .update(agents)
    .set({ productionVersionId: null })
    .where(eq(agents.organizationId, scope.organizationId));
  await db
    .delete(agentVersions)
    .where(eq(agentVersions.organizationId, scope.organizationId));
  await db.delete(agents).where(eq(agents.organizationId, scope.organizationId));
  await db
    .delete(organizations)
    .where(eq(organizations.id, scope.organizationId));
}
