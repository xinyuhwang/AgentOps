import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://agentops:agentops@localhost:5433/agentops";

/**
 * Next dev reloads modules on every edit; without this the pool count climbs
 * until Postgres refuses connections.
 */
const globalForDb = globalThis as unknown as {
  __agentopsSql?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__agentopsSql ?? postgres(connectionString, { max: 10 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__agentopsSql = sql;
}

export const db = drizzle(sql, { schema });
export type Db = typeof db;
