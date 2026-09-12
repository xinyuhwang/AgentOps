/**
 * The tenant scoping helper (§4, rule 3).
 *
 * There is one hardcoded organization today. The point of routing every read
 * through `scoped()` anyway is that adding a second org later is a change to
 * how `currentScope()` resolves, not an audit of every query in the codebase.
 *
 * Rule for this repo: no query against a tenant-owned table builds its own
 * bare `eq(...)` filter. It calls `scoped(table, scope, ...extra)`.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "./client";
import { apiKeys, organizations } from "./schema";
import { hashApiKey } from "@/core/auth/api-key";

export type Scope = { organizationId: string };

/** The single org until the workspace switcher lands in Phase 3. */
export const DEFAULT_ORG_SLUG = "acme";

type TenantTable = { organizationId: PgColumn };

/**
 * Always AND the tenant predicate in first. Every `where` on a tenant-owned
 * table goes through here.
 */
export function scoped<T extends TenantTable>(
  table: T,
  scope: Scope,
  ...extra: Array<SQL | undefined>
): SQL {
  // `and` returns `SQL | undefined`, but it can never be undefined here
  // because the tenant predicate is always present.
  return and(eq(table.organizationId, scope.organizationId), ...extra)!;
}

let cachedScope: Scope | undefined;

/**
 * Resolves the acting organization for server-side UI code.
 * Phase 3 replaces the body with a lookup off the session / workspace switcher;
 * callers do not change.
 */
export async function currentScope(): Promise<Scope> {
  if (cachedScope) return cachedScope;

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEFAULT_ORG_SLUG))
    .limit(1);

  if (!org) {
    throw new Error(
      `No organization with slug "${DEFAULT_ORG_SLUG}". Run \`pnpm db:seed\`.`,
    );
  }

  cachedScope = { organizationId: org.id };
  return cachedScope;
}

/**
 * Resolves scope from an `Authorization: Bearer <key>` header (§7.5).
 * Returns null rather than throwing so callers decide the status code.
 */
export async function scopeFromApiKey(
  authorization: string | null,
): Promise<Scope | null> {
  if (!authorization?.startsWith("Bearer ")) return null;

  const presented = authorization.slice("Bearer ".length).trim();
  if (!presented) return null;

  const [row] = await db
    .select({
      organizationId: apiKeys.organizationId,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(presented)))
    .limit(1);

  if (!row || row.revokedAt) return null;

  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.keyHash, hashApiKey(presented)));

  return { organizationId: row.organizationId };
}
