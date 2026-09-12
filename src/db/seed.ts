import { eq } from "drizzle-orm";
import { db, sql } from "./client";
import {
  agentVersionTools,
  agentVersions,
  agents,
  apiKeys,
  organizations,
  toolDefinitions,
  users,
} from "./schema";
import { DEFAULT_ORG_SLUG } from "./scope";
import { BUILTIN_TOOLS } from "@/core/tools/builtin";
import { generateApiKey } from "@/core/auth/api-key";

async function main() {
  const [org] = await db
    .insert(organizations)
    .values({ name: "Acme", slug: DEFAULT_ORG_SLUG })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: { name: "Acme" },
    })
    .returning();

  await db
    .insert(users)
    .values({
      organizationId: org.id,
      email: "member@acme.test",
      name: "Acme Member",
    })
    .onConflictDoNothing();

  // Tool definitions are seeded as immutable (key, version) rows so runs can
  // pin an exact version even though there is no registry UI in MVP.
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

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.organizationId, org.id))
    .limit(1);

  if (existing.length === 0) {
    const [agent] = await db
      .insert(agents)
      .values({
        organizationId: org.id,
        name: "Support triage",
        description: "Reads a customer issue, checks the data, drafts a reply.",
      })
      .returning();

    const [version] = await db
      .insert(agentVersions)
      .values({
        organizationId: org.id,
        agentId: agent.id,
        versionNo: 1,
        model: "claude-opus-5",
        systemInstructions:
          "You triage customer support issues. Check the data before answering, " +
          "and keep replies short and specific.",
        maxSteps: 8,
        timeoutMs: 15_000,
        maxRetries: 2,
        requireApprovalForSideEffecting: true,
      })
      .returning();

    await db
      .update(agents)
      .set({ productionVersionId: version.id })
      .where(eq(agents.id, agent.id));

    const attach = await db
      .select({ id: toolDefinitions.id, key: toolDefinitions.key })
      .from(toolDefinitions);

    await db.insert(agentVersionTools).values(
      attach
        .filter((t) => ["calculator", "web_search", "database_query"].includes(t.key))
        .map((t) => ({ agentVersionId: version.id, toolDefinitionId: t.id })),
    );

    console.log(`seeded agent "${agent.name}" v1`);

    // A second agent that attaches the one side-effecting built-in, so the
    // approval gate is reachable from the UI without hand-editing rows.
    const [notifier] = await db
      .insert(agents)
      .values({
        organizationId: org.id,
        name: "Ops notifier",
        description: "Looks into an alert and emails operations a summary.",
      })
      .returning();

    const [notifierV1] = await db
      .insert(agentVersions)
      .values({
        organizationId: org.id,
        agentId: notifier.id,
        versionNo: 1,
        model: "claude-opus-5",
        systemInstructions:
          "Investigate the alert, then email operations a short summary.",
        maxSteps: 6,
        requireApprovalForSideEffecting: true,
      })
      .returning();

    await db
      .update(agents)
      .set({ productionVersionId: notifierV1.id })
      .where(eq(agents.id, notifier.id));

    await db.insert(agentVersionTools).values(
      attach
        .filter((t) => ["web_search", "send_email"].includes(t.key))
        .map((t) => ({ agentVersionId: notifierV1.id, toolDefinitionId: t.id })),
    );

    console.log(`seeded agent "${notifier.name}" v1 (side-effecting)`);
  }

  const keyRows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, org.id))
    .limit(1);

  if (keyRows.length === 0) {
    const key = generateApiKey();
    await db.insert(apiKeys).values({
      organizationId: org.id,
      name: "Default key",
      keyHash: key.hash,
      keyPrefix: key.prefix,
    });
    // Shown once. Only the hash is stored, so this cannot be recovered later.
    console.log(`\n  API key (shown once): ${key.plaintext}\n`);
  }

  console.log("seed complete");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
