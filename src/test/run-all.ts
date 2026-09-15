/**
 * Test entry point.
 *
 * Node's built-in runner discovers `*.test.ts` inconsistently across versions
 * once a TypeScript loader is involved, so the suite is listed explicitly here
 * and executed with `tsx`. Importing a `node:test` file runs it.
 *
 * The integration suites need the Postgres from `pnpm db:up` and a schema from
 * `pnpm db:migrate`. Each suite creates and tears down its own organization, so
 * they leave no rows behind and do not disturb seeded data.
 */
export {};

await import("@/core/tools/dispatcher.test");
await import("@/core/run/history.test");
await import("@/core/agents/service.test");
await import("@/core/run/machine.test");

// The database pool is closed by the root `after` hooks in the integration
// suites (see `closeDb` in test/helpers).
