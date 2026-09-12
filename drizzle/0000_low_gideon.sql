CREATE TYPE "public"."approval_state" AS ENUM('pending', 'approved', 'approved_edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."assertion_kind" AS ENUM('none', 'exact', 'contains', 'json_subset', 'llm_judge');--> statement-breakpoint
CREATE TYPE "public"."assertion_result" AS ENUM('passed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."error_type" AS ENUM('model_error', 'tool_error', 'timeout', 'max_steps_exceeded', 'approval_rejected', 'internal');--> statement-breakpoint
CREATE TYPE "public"."eval_outcome" AS ENUM('completed', 'intervened', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('ok', 'error', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."step_type" AS ENUM('thought', 'tool_call', 'tool_result', 'approval', 'warning', 'completion');--> statement-breakpoint
CREATE TABLE "agent_version_tools" (
	"agent_version_id" uuid NOT NULL,
	"tool_definition_id" uuid NOT NULL,
	CONSTRAINT "agent_version_tools_unique" UNIQUE("agent_version_id","tool_definition_id")
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"model" text NOT NULL,
	"system_instructions" text DEFAULT '' NOT NULL,
	"max_steps" integer DEFAULT 12 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"require_approval_for_side_effecting" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "agent_versions_agent_no_unique" UNIQUE("agent_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"production_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"eval_set_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"n_completed" integer DEFAULT 0 NOT NULL,
	"n_intervened" integer DEFAULT 0 NOT NULL,
	"n_failed" integer DEFAULT 0 NOT NULL,
	"n_passed" integer DEFAULT 0 NOT NULL,
	"n_failed_assertion" integer DEFAULT 0 NOT NULL,
	"n_not_asserted" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_task_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"eval_task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"outcome" "eval_outcome" NOT NULL,
	"assertion_result" "assertion_result" NOT NULL,
	"latency_ms" integer,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"eval_set_id" uuid NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected_output" jsonb,
	"assertion" "assertion_kind" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"max_concurrent_runs" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"workflow_id" uuid,
	"label" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error_type" "error_type",
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"replayed_from_run_id" uuid,
	"replayed_from_step_ordinal" integer,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_ordinal" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"type" "step_type" NOT NULL,
	"label" text NOT NULL,
	"tool_definition_id" uuid,
	"arguments" jsonb,
	"result" jsonb,
	"status" "step_status" DEFAULT 'ok' NOT NULL,
	"error_type" "error_type",
	"error_detail" text,
	"approval_state" "approval_state",
	"approved_by_user_id" uuid,
	"approval_edit" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "steps_run_ordinal_attempt_unique" UNIQUE("run_id","ordinal","attempt")
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"json_schema" jsonb NOT NULL,
	"side_effecting" boolean DEFAULT false NOT NULL,
	"credential_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_definitions_key_version_unique" UNIQUE("key","version")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_org_email_unique" UNIQUE("organization_id","email")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_run_id" uuid,
	"agent_version_id" uuid NOT NULL,
	"input_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "agent_version_tools_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "agent_version_tools_tool_definition_id_tool_definitions_id_fk" FOREIGN KEY ("tool_definition_id") REFERENCES "public"."tool_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_sets" ADD CONSTRAINT "eval_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_sets" ADD CONSTRAINT "eval_sets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_task_results" ADD CONSTRAINT "eval_task_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_task_results" ADD CONSTRAINT "eval_task_results_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_task_results" ADD CONSTRAINT "eval_task_results_eval_task_id_eval_tasks_id_fk" FOREIGN KEY ("eval_task_id") REFERENCES "public"."eval_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_task_results" ADD CONSTRAINT "eval_task_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_tasks" ADD CONSTRAINT "eval_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_tasks" ADD CONSTRAINT "eval_tasks_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_tool_definition_id_tool_definitions_id_fk" FOREIGN KEY ("tool_definition_id") REFERENCES "public"."tool_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_versions_org_idx" ON "agent_versions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "eval_runs_set_idx" ON "eval_runs" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "eval_sets_org_idx" ON "eval_sets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "eval_task_results_run_idx" ON "eval_task_results" USING btree ("eval_run_id");--> statement-breakpoint
CREATE INDEX "eval_tasks_set_idx" ON "eval_tasks" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "runs_org_created_idx" ON "runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_agent_version_idx" ON "runs" USING btree ("agent_version_id");--> statement-breakpoint
CREATE INDEX "runs_claim_idx" ON "runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "steps_run_idx" ON "steps" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "workflows_org_idx" ON "workflows" USING btree ("organization_id");