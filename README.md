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

1. Open **Agents → Ops notifier → Overview**, enter a task, and press **Run**.
2. The trace page fills in as the worker advances the run, over SSE — one event per persisted step. The status bar shows `· live` while the stream is connected. Reload mid-run and it resumes from the steps already rendered rather than replaying the whole trace.
3. When the agent reaches `send_email`, the side-effecting action triggers a pause. The run enters `awaiting_approval`, and the worker releases its lease. No process remains blocked while waiting for approval.
4. Press **Approve** directly in the timeline. The run is re-queued, a worker claims it, and execution continues until completion.

To demonstrate crash recovery, stop the worker while a run is in progress and restart it. The worker resumes the run from its last persisted step because execution state is stored entirely in Postgres rather than in process memory.

Creating your own agent asks only for a name and a description, because configuration belongs to the Overview tab rather than to a second form that would duplicate it. A newly created agent is a **draft**: it cannot run until you save a configuration, and saving is what promotes it to production. That first save edits its v1 in place; only once a run has referenced a version does saving cut a new one.


From the command line:

```bash
pnpm enqueue "Investigate the nightly ETL alert" --agent "Ops notifier"
pnpm trace          # prints the most recent run's trace
pnpm test           # the full suite (see below)
```

## Tests

```bash
pnpm test
```

The suite uses Node's built-in test runner, so it adds no dependencies. Unit tests cover the tool dispatcher and history reconstruction and need nothing but Node. Integration tests exercise the real engine against the Postgres started by `pnpm db:up`, and each suite creates and tears down its own organization, so runs leave no rows behind and never disturb seeded data.

Phase 1's central claim is that the execution core is durable, so the suite tests that claim against a real database rather than relying on assertions about the implementation:

* **Approval.** A side-effecting tool suspends the run and the worker releases its lease. Nothing is sent before someone approves it, a rejected call never executes, and an approval cannot be resolved twice.
* **Resume.** A different worker, with no memory of the first, resumes the run from persisted state and completes it. It continues from the last saved step rather than restarting.
* **Crash recovery.** A run whose worker has died is reclaimed once its lease expires, while an active lease cannot be stolen. The per-organization concurrency cap holds, and a run that exceeds it waits rather than starving the pool.
* **Failure handling.** Tool failures are classified by type (`tool_error`, `timeout`, `internal`) rather than flattened into a single state. Timeouts are retried up to the configured limit with each attempt surfaced separately, while non-retryable failures stop immediately.
* **Agent versioning.** A new agent stays a draft until it is configured. The first save edits v1 in place, and once a run references a version, the next save cuts a new one and leaves the referenced version untouched.
* **Tenancy.** Every persisted step carries its run's organization, and agents and approvals belonging to another organization are invisible.

Note that if you leave `pnpm worker` running, it will compete with the tests for queued runs and cause spurious failures. Stop the worker before running the suite.

## Architecture Notes

**The run loop.** `src/core/run/machine.ts` reads the current run state from Postgres on every iteration, makes one decision, and persists the result before making the next. No execution state is carried between iterations in a closure. This makes suspend, resume, and crash recovery all use the same mechanism.

**Claiming.** `src/core/run/claim.ts` uses a single SQL statement to handle three concerns: reclaiming expired leases for crash recovery, using `FOR UPDATE SKIP LOCKED` to allow multiple workers without double-claiming runs, and enforcing a per-organization concurrency limit.

**Immutability.** Steps are append-only. Retries create new `attempt` rows under the same step ordinal, so the timeline preserves both attempts of step 4 as separate records. Saving an agent configuration creates a new `AgentVersion` rather than modifying the existing one, so every past run continues to reference the exact configuration that produced it.

**Side effects.** The `side_effecting` flag belongs to the tool definition rather than acting as a global switch for external actions. This gives the approval gate and replay guard a concrete, tool-level property to enforce.

**Tenancy.** `organization_id` is present on every table from migration #1, and every query goes through `scoped()` in `src/db/scope.ts`, even though the application currently uses a single hardcoded organization. Adding a second organization later requires changing `currentScope()`, rather than auditing every query for missing tenant filters.


## Not yet built

The rest of Phase 2 (workflow capture and re-run), Phase 3 (evaluations,
workspace switcher), and most of Phase 4 (structured logging, rate limits,
Docker image for the app itself). The `Workflows` nav item and the
`eval_sets` / `eval_tasks` / `eval_runs` tables exist but have no UI yet.

One known gap worth naming: `POST /api/workflows/:id/run` does not exist yet,
and when it does it needs the per-organization API key, since otherwise it is an
unauthenticated way to spend money.

## Versions

The **Versions** tab lists every version of an agent with its model, age, tool
count, and how many runs have actually exercised it — a version with no runs
behind it has no evidence behind it either. Exactly one version is production
at a time, and **Diff** compares any other version against it, which is the
comparison that answers "what would change if I promoted this".

Archiving hides a version from the Overview form but never deletes it, because
runs keep pointing at the exact config that produced them. The production
version cannot be archived, and an archived version cannot be promoted until
it is unarchived.

Saving edits the current version in place only while nothing has run against it
*and* it is still the production version. Once you promote an older version,
those two diverge, so saving always cuts a new version rather than silently
overwriting a version you were not looking at.

## Replay

Replay forks a trace rather than re-running it. Open a finished run, select a
model step, and press **Replay from step N**: steps `0..N-1` are copied into a
new run, which then continues from there with live tool calls against the same
agent version.

Forking is what makes this safe. Nothing before the fork point executes again,
so a side-effecting call in the copied prefix keeps its recorded result instead
of sending a second email. The state machine needs no knowledge of replay at
all — it rebuilds state from persisted steps, so a copied prefix looks exactly
like one it produced itself.

Two consequences. The fork point has to be a clean model-turn boundary, because
a copied thought step replays as an assistant turn carrying its `tool_use`
blocks, and cutting between that turn and its results would leave a tool call
unanswered; `checkForkPoint` refuses those, and refuses to carry an unresolved
approval across. And the replay's cost starts at zero, because the prefix's
spend belongs to the source run — copied steps keep their original cost, so the
numbers stay reconcilable.
