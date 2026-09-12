# AgentOps

A small platform for building, running and observing AI agents. The trace
inspector is the centerpiece; everything else feeds it data or acts on what it
shows. See [design-doc.md](design-doc.md) for the full design.

**Phase 1 (execution core) is implemented.** The run engine is a durable state
machine in Postgres from the first migration — not an in-memory loop — so
suspend/resume, crash recovery and human approval work now rather than
requiring the core to be rewritten in later phases.

## Stack

Next.js (App Router) + Postgres + Drizzle for the API and UI, with a separate
long-running Node worker that claims and advances runs.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres on :5433 via Docker
pnpm db:migrate
pnpm db:seed        # one org, two agents, the built-in tools, an API key
```

The seed prints an API key once — only its hash is stored.

Then, in two terminals:

```bash
pnpm dev            # http://localhost:3000
pnpm worker         # claims queued runs and advances them
```

Without `ANTHROPIC_API_KEY`, the engine uses a deterministic scripted provider,
so the whole loop runs end to end with no spend. Set `LLM_PROVIDER=anthropic`
to make real calls.

## Demo

1. Open **Agents → Ops notifier → Overview**, enter a task, press **Run**.
2. The trace page fills in as the worker makes progress. It's polling in Phase
   1; Phase 2 swaps that for SSE.
3. The agent reaches `send_email`, which is marked `side_effecting`, so the run
   **suspends** — status `awaiting_approval`, worker lease released. Nothing is
   holding a process open.
4. Press **Approve** inline in the timeline. The run re-queues, a worker picks
   it back up, and it finishes.

Stop the worker while a run is in flight and start it again: the run resumes
from the last persisted step, because there was never any state anywhere else.

From the command line:

```bash
pnpm enqueue "Investigate the nightly ETL alert" --agent "Ops notifier"
pnpm trace          # prints the most recent run's trace
pnpm verify         # Phase 1 acceptance checks (see below)
```

## What `pnpm verify` proves

Phase 1's claim is that the core is durable. `pnpm verify` checks it against a
real database rather than asserting it:

- **A** — a side-effecting tool suspends the run and the worker releases its
  lease; no email is sent before approval.
- **B** — a *different* worker, with no memory of the first, resumes mid-run
  from persisted state and finishes. It continues rather than restarting.
- **C** — a run whose worker died is reclaimed once its lease expires, and a
  live lease is not stealable.
- **D** — tool failures are classified (`tool_error`, `timeout`, …) rather than
  flattened into one failure, and non-retryable failures aren't retried.

## Architecture notes

**The run loop.** `src/core/run/machine.ts` reads run state back out of
Postgres on every iteration, decides one thing, and persists it before deciding
the next. Nothing is carried between iterations in a closure. That single
property is what makes suspend, resume and crash recovery the same mechanism.

**Claiming.** `src/core/run/claim.ts` is one SQL statement doing three things:
reclaiming expired leases (crash recovery), `FOR UPDATE SKIP LOCKED` (several
workers, no double-claim), and a per-organization concurrency cap.

**Immutability.** Steps are append-only. Retries are new `attempt` rows under
the same ordinal, so the timeline shows two attempts of step 4 as two rows.
Saving agent config writes a new `AgentVersion` rather than editing one, so
every past run still points at the exact config that produced it.

**Side effects.** `side_effecting` lives on the tool definition, not as a
global "block external actions" switch — that's what gives the approval gate
and the replay guard something concrete to key off.

**Tenancy.** `organization_id` is on every table from migration #1 and every
query goes through `scoped()` in `src/db/scope.ts`, even with one hardcoded
org. Adding a second org later is a change to `currentScope()`, not an audit of
every query.

## Not yet built

Phase 2 (workflows, agent-version UI, SSE, replay UI), Phase 3 (evaluations,
workspace switcher), Phase 4 (test suite, structured logging, rate limits,
Docker image for the app itself). The `Workflows` nav item and the
`eval_sets` / `eval_tasks` / `eval_runs` tables exist but have no UI yet.
