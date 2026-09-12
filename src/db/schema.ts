/**
 * Migration #1 — the whole §4 schema.
 *
 * Three invariants this file exists to enforce:
 *   1. Traces are immutable. Steps are append-only; retries and replays add
 *      rows. The single mutable column is `approval_state` resolving away
 *      from `pending`.
 *   2. Every run can say exactly what produced it: Run -> AgentVersion ->
 *      pinned ToolDefinition versions.
 *   3. Every row is tenant-scoped from day one. `organization_id` is on every
 *      table even though there is one hardcoded org today (see db/scope.ts).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `awaiting_approval` exists from migration #1 even though nothing sets it
 * until Phase 3. Phase 3 makes it *reachable*, not *possible* — that is the
 * whole point of building the durable machine first.
 */
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const stepType = pgEnum("step_type", [
  "thought",
  "tool_call",
  "tool_result",
  "approval",
  "warning",
  "completion",
]);

export const stepStatus = pgEnum("step_status", [
  "ok",
  "error",
  "rejected",
  "superseded",
]);

export const approvalState = pgEnum("approval_state", [
  "pending",
  "approved",
  "approved_edited",
  "rejected",
]);

/** §7.6 — the trace renders these distinctly rather than one red icon. */
export const errorType = pgEnum("error_type", [
  "model_error",
  "tool_error",
  "timeout",
  "max_steps_exceeded",
  "approval_rejected",
  "internal",
]);

export const assertionKind = pgEnum("assertion_kind", [
  "none",
  "exact",
  "contains",
  "json_subset",
  "llm_judge",
]);

export const evalOutcome = pgEnum("eval_outcome", [
  "completed",
  "intervened",
  "failed",
]);

export const assertionResult = pgEnum("assertion_result", [
  "passed",
  "failed",
  "skipped",
]);

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(3),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("users_org_email_unique").on(t.organizationId, t.email)],
);

/**
 * §7.5 — one scoped key per org, hashed at rest. Without this the public
 * `POST /api/workflows/:id/run` endpoint is an unauthenticated way to spend
 * money, and the tenant boundary is asserted rather than demonstrated.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("api_keys_hash_idx").on(t.keyHash)],
);

/* -------------------------------------------------------------------------- */
/* Agents and tools                                                           */
/* -------------------------------------------------------------------------- */

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Nullable FK rather than a flag on AgentVersion: exactly one version is
     * production at a time, and pointing at it from here makes that
     * structurally true instead of a constraint we have to police.
     * Set via SQL after the version row exists (circular FK, see migrate.ts).
     */
    productionVersionId: uuid("production_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agents_org_idx").on(t.organizationId)],
);

/**
 * Immutable once any Run references it. New config is a new row, never a
 * copied Agent — so `Run.agent_version_id` is a real FK to the exact prompt,
 * model and limits that produced the run.
 */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    model: text("model").notNull(),
    systemInstructions: text("system_instructions").notNull().default(""),
    maxSteps: integer("max_steps").notNull().default(12),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    maxRetries: integer("max_retries").notNull().default(2),
    /**
     * Scope comes from the tool definition's `side_effecting` flag, not from a
     * global notion of "external" — this boolean only decides whether that
     * flag is honoured (§3.2).
     */
    requireApprovalForSideEffecting: boolean("require_approval_for_side_effecting")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("agent_versions_agent_no_unique").on(t.agentId, t.versionNo),
    index("agent_versions_org_idx").on(t.organizationId),
  ],
);

/**
 * Exists in MVP even though there is no registry UI: runs must be able to pin
 * a tool *version* regardless of whether users can browse one. Rows are
 * immutable; changing a tool means inserting a new (key, version).
 *
 * `organization_id` is null for built-in tools shared across tenants.
 */
export const toolDefinitions = pgTable(
  "tool_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    jsonSchema: jsonb("json_schema").notNull(),
    /** Drives both the approval gate (§3.2) and the replay guard (§7.3). */
    sideEffecting: boolean("side_effecting").notNull().default(false),
    /** §7.7 — a *reference* to a secret, never the secret itself. */
    credentialRef: text("credential_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("tool_definitions_key_version_unique").on(t.key, t.version)],
);

/** Pins the exact tool version to the agent version, not just the tool. */
export const agentVersionTools = pgTable(
  "agent_version_tools",
  {
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    toolDefinitionId: uuid("tool_definition_id")
      .notNull()
      .references(() => toolDefinitions.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("agent_version_tools_unique").on(t.agentVersionId, t.toolDefinitionId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Workflows                                                                  */
/* -------------------------------------------------------------------------- */

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceRunId: uuid("source_run_id"),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "restrict" }),
    inputSchema: jsonb("input_schema").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workflows_org_idx").on(t.organizationId)],
);

/* -------------------------------------------------------------------------- */
/* Runs and steps                                                             */
/* -------------------------------------------------------------------------- */

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "restrict" }),
    workflowId: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "set null",
    }),
    label: text("label"),
    status: runStatus("status").notNull().default("queued"),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    errorType: errorType("error_type"),
    errorDetail: text("error_detail"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),

    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),

    /** Replay produces a new Run; traces are never mutated (§3.3, §7.3). */
    replayedFromRunId: uuid("replayed_from_run_id"),
    replayedFromStepOrdinal: integer("replayed_from_step_ordinal"),

    /**
     * The worker claim. A crashed worker's runs become reclaimable once the
     * lease expires, which is what makes "resumes from the last persisted
     * step" true rather than aspirational.
     */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Next ordinal to write. Persisted so resume needs no in-memory state. */
    nextOrdinal: integer("next_ordinal").notNull().default(0),
  },
  (t) => [
    index("runs_org_created_idx").on(t.organizationId, t.createdAt),
    index("runs_agent_version_idx").on(t.agentVersionId),
    /** The worker claim query: status + lease expiry. */
    index("runs_claim_idx").on(t.status, t.leaseExpiresAt),
  ],
);

/**
 * Append-only. `attempt` is why retries render honestly: two attempts of
 * step 4 are two rows, not one row that changed its mind.
 */
export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    attempt: integer("attempt").notNull().default(1),
    type: stepType("type").notNull(),
    label: text("label").notNull(),
    toolDefinitionId: uuid("tool_definition_id").references(
      () => toolDefinitions.id,
      { onDelete: "set null" },
    ),

    /** Secrets are redacted before write, not before render (§7.7). */
    arguments: jsonb("arguments"),
    result: jsonb("result"),

    status: stepStatus("status").notNull().default("ok"),
    errorType: errorType("error_type"),
    errorDetail: text("error_detail"),

    /** The one mutable field: resolves away from `pending` exactly once. */
    approvalState: approvalState("approval_state"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvalEdit: jsonb("approval_edit"),

    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    unique("steps_run_ordinal_attempt_unique").on(t.runId, t.ordinal, t.attempt),
    index("steps_run_idx").on(t.runId, t.ordinal),
  ],
);

/* -------------------------------------------------------------------------- */
/* Evaluations                                                                */
/* -------------------------------------------------------------------------- */

export const evalSets = pgTable(
  "eval_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("eval_sets_org_idx").on(t.organizationId)],
);

/**
 * `expectedOutput` + `assertion` are what separate correctness from
 * completion (§3.4). A task with assertion `none` is a liveness check and is
 * reported as "not asserted" rather than silently counted as a pass.
 */
export const evalTasks = pgTable(
  "eval_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    evalSetId: uuid("eval_set_id")
      .notNull()
      .references(() => evalSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    input: jsonb("input").notNull(),
    expectedOutput: jsonb("expected_output"),
    assertion: assertionKind("assertion").notNull().default("none"),
  },
  (t) => [index("eval_tasks_set_idx").on(t.evalSetId)],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    evalSetId: uuid("eval_set_id")
      .notNull()
      .references(() => evalSets.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** Axis 1: did it finish? */
    nCompleted: integer("n_completed").notNull().default(0),
    nIntervened: integer("n_intervened").notNull().default(0),
    nFailed: integer("n_failed").notNull().default(0),
    /** Axis 2: was it right? */
    nPassed: integer("n_passed").notNull().default(0),
    nFailedAssertion: integer("n_failed_assertion").notNull().default(0),
    nNotAsserted: integer("n_not_asserted").notNull().default(0),
  },
  (t) => [index("eval_runs_set_idx").on(t.evalSetId)],
);

export const evalTaskResults = pgTable(
  "eval_task_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    evalRunId: uuid("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    evalTaskId: uuid("eval_task_id")
      .notNull()
      .references(() => evalTasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    outcome: evalOutcome("outcome").notNull(),
    assertionResult: assertionResult("assertion_result").notNull(),
    latencyMs: integer("latency_ms"),
    toolCalls: integer("tool_calls").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
  },
  (t) => [index("eval_task_results_run_idx").on(t.evalRunId)],
);

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type Organization = typeof organizations.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type ToolDefinition = typeof toolDefinitions.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type RunStatus = (typeof runStatus.enumValues)[number];
export type StepType = (typeof stepType.enumValues)[number];
export type ErrorType = (typeof errorType.enumValues)[number];
