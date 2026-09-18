import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersionTools, agentVersions, agents, runs } from "@/db/schema";
import { scoped, type Scope } from "@/db/scope";

export type AgentConfig = {
  model: string;
  systemInstructions: string;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  requireApprovalForSideEffecting: boolean;
  toolDefinitionIds: string[];
};

/**
 * Creates an agent and a starting v1, but deliberately does **not** promote it
 * to production.
 *
 * The draft/production dot in §3.1 only carries information if something can
 * actually be a draft. An agent created with empty instructions and no tools
 * has not been configured by anyone, so it reads as `draft` until its first
 * save. It also cannot be run, which is the honest outcome: running an agent
 * with no instructions and no tools produces nothing worth a trace.
 */
export async function createAgentWithDraft(
  scope: Scope,
  params: { name: string; description?: string | null },
): Promise<{ agentId: string; versionId: string }> {
  const [agent] = await db
    .insert(agents)
    .values({
      organizationId: scope.organizationId,
      name: params.name,
      description: params.description || null,
    })
    .returning();

  const [version] = await db
    .insert(agentVersions)
    .values({
      organizationId: scope.organizationId,
      agentId: agent.id,
      versionNo: 1,
      model: "claude-opus-5",
      systemInstructions: "",
    })
    .returning();

  return { agentId: agent.id, versionId: version.id };
}

/**
 * Promotes an existing version to production (§3.6). Exactly one version is
 * production at a time, which the schema makes structurally true by pointing
 * at it from the agent rather than flagging it on the version.
 */
export async function promoteVersion(
  scope: Scope,
  agentId: string,
  versionId: string,
): Promise<void> {
  const [version] = await db
    .select()
    .from(agentVersions)
    .where(
      scoped(
        agentVersions,
        scope,
        and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agentId)),
      ),
    )
    .limit(1);

  if (!version) throw new Error("Version not found for this agent");
  if (version.archivedAt) {
    // Promoting an archived version would contradict the reason it was
    // archived; unarchive it deliberately first.
    throw new Error("Unarchive this version before promoting it");
  }

  await db
    .update(agents)
    .set({ productionVersionId: versionId })
    .where(scoped(agents, scope, eq(agents.id, agentId)));
}

/**
 * Archiving is a display concern, not a delete: runs keep pointing at archived
 * versions, and their traces must still say exactly what produced them.
 */
export async function setVersionArchived(
  scope: Scope,
  agentId: string,
  versionId: string,
  archived: boolean,
): Promise<void> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");
  if (archived && agent.productionVersionId === versionId) {
    throw new Error(
      "This version is in production. Promote another version before archiving it.",
    );
  }

  const updated = await db
    .update(agentVersions)
    .set({ archivedAt: archived ? new Date() : null })
    .where(
      scoped(
        agentVersions,
        scope,
        and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agentId)),
      ),
    )
    .returning({ id: agentVersions.id });

  if (updated.length === 0) throw new Error("Version not found for this agent");
}

/** A version is frozen as soon as any run points at it. */
export async function isVersionReferenced(versionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.agentVersionId, versionId))
    .limit(1);
  return Boolean(row);
}

/**
 * Saves config and promotes the result to production.
 *
 * The immutability rule is "immutable once any Run references it" — so the
 * latest version is edited in place while nothing has run against it, and a new
 * version is cut the moment one has. That keeps the guarantee that every run
 * points at the exact config that produced it, without leaving an empty v1
 * stub behind every agent anyone creates.
 */
export async function saveAgentConfigFor(
  scope: Scope,
  agentId: string,
  config: AgentConfig,
): Promise<{ versionId: string; versionNo: number; createdNewVersion: boolean }> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(scoped(agents, scope, eq(agents.id, agentId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");

  const [latest] = await db
    .select()
    .from(agentVersions)
    .where(scoped(agentVersions, scope, eq(agentVersions.agentId, agentId)))
    .orderBy(desc(agentVersions.versionNo))
    .limit(1);

  const fields = {
    model: config.model,
    systemInstructions: config.systemInstructions,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    requireApprovalForSideEffecting: config.requireApprovalForSideEffecting,
  };

  /**
   * Edit in place only while the latest version is also the one in production.
   *
   * Once an older version can be promoted, those diverge — and the Overview
   * form renders the *production* version. Editing the latest row then would
   * silently overwrite a version the user was not looking at. Archived
   * versions are likewise never edited in place.
   */
  const editInPlace = latest
    ? latest.archivedAt === null &&
      // A never-promoted draft has no production version yet; its v1 is still
      // the row the form is showing, so editing it in place is correct.
      (agent.productionVersionId === null ||
        latest.id === agent.productionVersionId) &&
      !(await isVersionReferenced(latest.id))
    : false;

  let versionId: string;
  let versionNo: number;

  if (latest && editInPlace) {
    await db
      .update(agentVersions)
      .set(fields)
      .where(eq(agentVersions.id, latest.id));

    // Tool attachments are replaced wholesale; the join table has no history
    // of its own, the version row is the unit of record.
    await db
      .delete(agentVersionTools)
      .where(eq(agentVersionTools.agentVersionId, latest.id));

    versionId = latest.id;
    versionNo = latest.versionNo;
  } else {
    const [created] = await db
      .insert(agentVersions)
      .values({
        organizationId: scope.organizationId,
        agentId,
        versionNo: (latest?.versionNo ?? 0) + 1,
        ...fields,
      })
      .returning();

    versionId = created.id;
    versionNo = created.versionNo;
  }

  if (config.toolDefinitionIds.length > 0) {
    await db.insert(agentVersionTools).values(
      config.toolDefinitionIds.map((toolDefinitionId) => ({
        agentVersionId: versionId,
        toolDefinitionId,
      })),
    );
  }

  await db
    .update(agents)
    .set({ productionVersionId: versionId })
    .where(and(scoped(agents, scope), eq(agents.id, agentId)));

  return { versionId, versionNo, createdNewVersion: !editInPlace };
}
