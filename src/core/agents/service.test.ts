import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentVersionTools, agentVersions, agents } from "@/db/schema";
import type { Scope } from "@/db/scope";
import {
  createAgentWithDraft,
  promoteVersion,
  saveAgentConfigFor,
  setVersionArchived,
} from "./service";
import {
  closeDb,
  createTestOrg,
  destroyTestOrg,
  ensureBuiltinTools,
  recordCompletedRun,
} from "@/test/helpers";

after(closeDb);

/**
 * The agent lifecycle, which is where two bugs lived:
 *   - a new agent showed as "production" before anyone configured it, draining
 *     the draft/production dot of meaning;
 *   - the first save cut a v2, leaving an empty v1 stub behind every agent.
 */
describe("agent lifecycle", () => {
  let scope: Scope;
  let tools: Map<string, { id: string; key: string }>;

  before(async () => {
    scope = await createTestOrg();
    tools = await ensureBuiltinTools();
  });

  after(async () => {
    await destroyTestOrg(scope);
  });

  const config = (overrides: Partial<Parameters<typeof saveAgentConfigFor>[2]> = {}) => ({
    model: "claude-opus-5",
    systemInstructions: "Be useful.",
    maxSteps: 8,
    timeoutMs: 15_000,
    maxRetries: 2,
    requireApprovalForSideEffecting: true,
    toolDefinitionIds: [tools.get("calculator")!.id],
    ...overrides,
  });

  test("a newly created agent is a draft, not production", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Fresh" });

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId));

    assert.equal(agent.productionVersionId, null);
  });

  test("a draft agent still has a v1 to render the config form from", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Fresh 2" });

    const versions = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));

    assert.equal(versions.length, 1);
    assert.equal(versions[0].versionNo, 1);
    assert.equal(versions[0].systemInstructions, "");
  });

  test("the first save edits v1 in place and promotes it", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "First save" });

    const result = await saveAgentConfigFor(scope, agentId, config());

    assert.equal(result.versionNo, 1, "should still be v1");
    assert.equal(result.createdNewVersion, false, "should not cut a new version");

    const versions = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));

    assert.equal(versions.length, 1, "no empty v1 stub left behind");
    assert.equal(versions[0].systemInstructions, "Be useful.");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    assert.equal(agent.productionVersionId, versions[0].id);
  });

  test("repeated saves keep editing v1 while nothing has run", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Many saves" });

    await saveAgentConfigFor(scope, agentId, config());
    await saveAgentConfigFor(scope, agentId, config({ systemInstructions: "v1 again" }));
    const third = await saveAgentConfigFor(scope, agentId, config({ maxSteps: 3 }));

    assert.equal(third.versionNo, 1);

    const versions = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));

    assert.equal(versions.length, 1);
    assert.equal(versions[0].maxSteps, 3);
  });

  test("once a run references a version, the next save cuts a new one", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Frozen" });
    const saved = await saveAgentConfigFor(scope, agentId, config());

    // A run now points at v1, so v1 is the record of what produced it.
    await recordCompletedRun(scope, saved.versionId);

    const next = await saveAgentConfigFor(
      scope,
      agentId,
      config({ systemInstructions: "changed after a run" }),
    );

    assert.equal(next.createdNewVersion, true);
    assert.equal(next.versionNo, 2);

    // v1 must be untouched — this is the immutability guarantee.
    const [v1] = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.id, saved.versionId));
    assert.equal(v1.systemInstructions, "Be useful.");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    assert.equal(agent.productionVersionId, next.versionId, "v2 is promoted");
  });

  test("saving replaces tool attachments rather than accumulating them", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Tools" });

    await saveAgentConfigFor(
      scope,
      agentId,
      config({
        toolDefinitionIds: [
          tools.get("calculator")!.id,
          tools.get("web_search")!.id,
        ],
      }),
    );
    const second = await saveAgentConfigFor(
      scope,
      agentId,
      config({ toolDefinitionIds: [tools.get("web_search")!.id] }),
    );

    const attached = await db
      .select()
      .from(agentVersionTools)
      .where(eq(agentVersionTools.agentVersionId, second.versionId));

    assert.equal(attached.length, 1);
    assert.equal(attached[0].toolDefinitionId, tools.get("web_search")!.id);
  });

  test("an agent from another organization cannot be configured", async () => {
    const other = await createTestOrg();
    try {
      const { agentId } = await createAgentWithDraft(other, { name: "Theirs" });

      await assert.rejects(
        () => saveAgentConfigFor(scope, agentId, config()),
        /Agent not found/,
      );
    } finally {
      await destroyTestOrg(other);
    }
  });

  test("version numbers increase monotonically", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Monotonic" });

    let saved = await saveAgentConfigFor(scope, agentId, config());
    for (let i = 0; i < 3; i++) {
      await recordCompletedRun(scope, saved.versionId);
      saved = await saveAgentConfigFor(scope, agentId, config());
    }

    const versions = await db
      .select({ versionNo: agentVersions.versionNo })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(desc(agentVersions.versionNo));

    assert.deepEqual(
      versions.map((v) => v.versionNo),
      [4, 3, 2, 1],
    );
  });

  test("promoting an older version makes it production", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Promote" });
    const v1 = await saveAgentConfigFor(scope, agentId, config());
    await recordCompletedRun(scope, v1.versionId);
    const v2 = await saveAgentConfigFor(
      scope,
      agentId,
      config({ systemInstructions: "second" }),
    );

    let [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    assert.equal(agent.productionVersionId, v2.versionId);

    await promoteVersion(scope, agentId, v1.versionId);

    [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    assert.equal(agent.productionVersionId, v1.versionId);
  });

  test("saving never edits in place once production is behind the latest version", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Diverged" });
    const v1 = await saveAgentConfigFor(scope, agentId, config());
    await recordCompletedRun(scope, v1.versionId);

    // v2 has no runs, so it would normally be editable in place.
    const v2 = await saveAgentConfigFor(
      scope,
      agentId,
      config({ systemInstructions: "v2 text" }),
    );

    // Demote to v1: now the Overview form renders v1 while v2 is still latest.
    await promoteVersion(scope, agentId, v1.versionId);

    const next = await saveAgentConfigFor(
      scope,
      agentId,
      config({ systemInstructions: "edited from v1" }),
    );

    assert.equal(next.createdNewVersion, true, "must not overwrite v2");
    assert.equal(next.versionNo, 3);

    // v2 is untouched — the user was not looking at it.
    const [untouched] = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.id, v2.versionId));
    assert.equal(untouched.systemInstructions, "v2 text");
  });

  test("the production version cannot be archived", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "NoArchive" });
    const v1 = await saveAgentConfigFor(scope, agentId, config());

    await assert.rejects(
      () => setVersionArchived(scope, agentId, v1.versionId, true),
      /Promote another version/,
    );
  });

  test("an archived version cannot be promoted until it is unarchived", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "Archived" });
    const v1 = await saveAgentConfigFor(scope, agentId, config());
    await recordCompletedRun(scope, v1.versionId);
    await saveAgentConfigFor(scope, agentId, config({ maxSteps: 4 }));

    await setVersionArchived(scope, agentId, v1.versionId, true);

    await assert.rejects(
      () => promoteVersion(scope, agentId, v1.versionId),
      /Unarchive/,
    );

    await setVersionArchived(scope, agentId, v1.versionId, false);
    await promoteVersion(scope, agentId, v1.versionId);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    assert.equal(agent.productionVersionId, v1.versionId);
  });

  test("an archived latest version is not edited in place", async () => {
    const { agentId } = await createAgentWithDraft(scope, { name: "ArchLatest" });
    const v1 = await saveAgentConfigFor(scope, agentId, config());
    await recordCompletedRun(scope, v1.versionId);
    const v2 = await saveAgentConfigFor(scope, agentId, config({ maxSteps: 5 }));

    await promoteVersion(scope, agentId, v1.versionId);
    await setVersionArchived(scope, agentId, v2.versionId, true);

    const next = await saveAgentConfigFor(scope, agentId, config({ maxSteps: 6 }));
    assert.equal(next.createdNewVersion, true);
    assert.equal(next.versionNo, 3);
  });

  test("a version from another organization cannot be promoted", async () => {
    const other = await createTestOrg();
    try {
      const { agentId } = await createAgentWithDraft(scope, { name: "Tenant" });
      const v1 = await saveAgentConfigFor(scope, agentId, config());

      await assert.rejects(
        () => promoteVersion(other, agentId, v1.versionId),
        /not found/,
      );
    } finally {
      await destroyTestOrg(other);
    }
  });
});
