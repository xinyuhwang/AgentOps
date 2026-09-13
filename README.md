# AgentOps

A small platform for building, running and observing AI agents. The trace
inspector is the centerpiece; everything else feeds it data or acts on what it
shows. See [design-doc.md](design-doc.md) for the full design.

**Phase 1 (execution core) is implemented.** The run engine uses PostgreSQL as a durable state machine rather than relying on an in-memory loop. This allows runs to be suspended and resumed, recovered after crashes, and paused for human approval without requiring a major redesign in later phases.

## Stack

Next.js (App Router), Postgres, and Drizzle power the application and API. A separate long-running Node.js worker claims and advances runs, keeping execution independent from the web request lifecycle.


## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres on :5433 via Docker
pnpm db:migrate
pnpm db:seed        # one org, two agents, the built-in tools, an API key
```

The seed prints an API key once, only its hash is stored.

Then, in two terminals:

```bash
pnpm dev            # http://localhost:3000
pnpm worker         # claims queued runs and advances them
```

Without `ANTHROPIC_API_KEY`, the engine uses a deterministic scripted provider,
so the whole loop runs end to end with no spend. Set `LLM_PROVIDER=anthropic`
to make real calls.

## Demo

1. Open **Agents → Ops Notifier → Overview**, enter a task, and press **Run**.
2. The trace page updates as the worker advances the run. Phase 1 uses polling; Phase 2 will replace polling with SSE.
3. When the agent reaches `send_email`, the side-effecting action triggers a pause. The run enters `awaiting_approval`, and the worker releases its lease. No process remains blocked while waiting for approval.
4. Press **Approve** directly in the timeline. The run is re-queued, a worker claims it, and execution continues until completion.

To demonstrate crash recovery, stop the worker while a run is in progress and restart it. The worker resumes the run from its last persisted step because execution state is stored entirely in Postgres rather than in process memory.


From the command line:

```bash
pnpm enqueue "Investigate the nightly ETL alert" --agent "Ops notifier"
pnpm trace          # prints the most recent run's trace
pnpm verify         # Phase 1 acceptance checks (see below)
```

## What `pnpm verify` proves

Phase 1's central claim is that the execution core is durable. `pnpm verify` tests that claim against a real database rather than relying on assertions about the implementation:

* **A — Approval:** A side-effecting tool suspends the run and the worker releases its lease. No email is sent before approval.
* **B — Resume:** A different worker, with no memory of the first worker, resumes the run from persisted state and completes it. It continues from the saved step rather than restarting.
* **C — Crash recovery:** A run whose worker has died is reclaimed after its lease expires, while an active lease cannot be stolen.
* **D — Failure handling:** Tool failures are classified by type (`tool_error`, `timeout`, etc.) rather than flattened into a single failure state. Non-retryable failures are not retried.

## Architecture Notes

**The run loop.** `src/core/run/machine.ts` reads the current run state from Postgres on every iteration, makes one decision, and persists the result before making the next. No execution state is carried between iterations in a closure. This makes suspend, resume, and crash recovery all use the same mechanism.

**Claiming.** `src/core/run/claim.ts` uses a single SQL statement to handle three concerns: reclaiming expired leases for crash recovery, using `FOR UPDATE SKIP LOCKED` to allow multiple workers without double-claiming runs, and enforcing a per-organization concurrency limit.

**Immutability.** Steps are append-only. Retries create new `attempt` rows under the same step ordinal, so the timeline preserves both attempts of step 4 as separate records. Saving an agent configuration creates a new `AgentVersion` rather than modifying the existing one, so every past run continues to reference the exact configuration that produced it.

**Side effects.** The `side_effecting` flag belongs to the tool definition rather than acting as a global switch for external actions. This gives the approval gate and replay guard a concrete, tool-level property to enforce.

**Tenancy.** `organization_id` is present on every table from migration #1, and every query goes through `scoped()` in `src/db/scope.ts`, even though the application currently uses a single hardcoded organization. Adding a second organization later requires changing `currentScope()`, rather than auditing every query for missing tenant filters.


## Not yet built

Phase 2 (workflows, agent-version UI, SSE, replay UI), Phase 3 (evaluations,
workspace switcher), Phase 4 (test suite, structured logging, rate limits,
Docker image for the app itself). The `Workflows` nav item and the
`eval_sets` / `eval_tasks` / `eval_runs` tables exist but have no UI yet.
