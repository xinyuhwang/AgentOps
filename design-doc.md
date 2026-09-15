# AgentOps Design Doc

## 1. Vision

AgentOps is a small, polished platform for building, running, and observing AI agents. The goal is for the product to feel like a well-made tool rather than a crowded dashboard: every screen should show exactly what the user needs for the task in front of them, and nothing more.

**Core loop:** Create agent → configure tools → define task → run →
inspect trace → approve/intervene → evaluate → save as workflow → reuse.

The execution trace inspector is the centerpiece of the product. Every other screen exists either to feed data into the trace or to act on what the trace shows.

---

## 2. Information architecture

The primary navigation is intentionally flat, with only three top-level items. Additional depth lives inside each agent rather than in the global sidebar, which keeps the sidebar itself simple:

```
Dashboard
Agents
  └─ Agent detail
       ├─ Overview   (config: model, prompt, tools, execution limits)
       ├─ Runs        (list → run trace)
       ├─ Evaluations (aggregate metrics + eval-set runner)
       └─ Versions    (v1 / v2 / v3, diff, promote to production)
Workflows
  └─ Workflow detail (saved run → steps → run again / API endpoint)
```

There is no standalone "Tools" or "Runs" item in the top-level navigation for the MVP. Tools are attached from within an agent's configuration screen; a global tool registry can be added later, once agents share enough tools to justify one. Similarly, "Runs" lives underneath each agent rather than existing as a single list spanning every agent, since a recent-runs list on the Dashboard already covers the cross-agent view.

A workspace switcher, which supports multi-tenancy, sits in the top-right corner next to the user menu. It changes which organization's data every other screen displays; it is not a page in its own right.

---

## 3. Screens

### 3.1 Dashboard
Purpose: "what's happening right now." Two things only:
- **Agents** — name, status dot (draft / production), last run time, completion rate (trailing 30 days). One row per agent, no cards with stats stacked on stats.
- **Recent runs** — task name, status icon, duration, agent. Click → run trace.

No stat-card row, no charts, no notification toasts layered on buttons.
If a number matters enough to headline, it goes in the agent's own
Evaluations tab, not duplicated here.

### 3.2 Agent detail — Overview (configure)
A single form, top to bottom, one column:
- Model selector
- System instructions (textarea)
- Tools (checkbox list — search, database, calculator, browser, etc.).
  Tools whose definition carries `side_effecting: true` are marked in
  the list, since they're the ones approval and replay treat specially.
- Execution limits (max steps, timeout, retries) — collapsed under an
  "Execution" disclosure, since most users won't touch defaults
- Human approval toggle: "Require approval before side-effecting tools."
  Scope comes from the tool definition, not from a global notion of
  "external" — an agent with no side-effecting tools attached shows the
  toggle disabled with that reason, rather than an all-or-nothing switch
  that blocks either everything or nothing.
- Run button (primary, bottom right)

No sidebar of metrics next to the form. Config is config; results live
in Runs.

### 3.3 Run trace
The centerpiece — three columns, borrowing the AgentIO reference:
- **Timeline** (left/center): chronological list of steps — thought,
  tool call, tool result, warning, approval request, completion. Each
  row: timestamp, icon, one-line label, duration.
- **Inspector** (right): click any step → its detail. Tabs: Overview
  (name, timing), Data (arguments/result JSON), Errors (if any).
- **Status bar** (top): run id, elapsed time, status (running /
  awaiting approval / completed / failed), and — when relevant — a
  single "Replay from step N" action.

Replay creates a *new* run rather than mutating this one; traces are
immutable. The replay runs live tool calls and halts at the first
side-effecting step, surfacing an approval request there — replaying
past a step that already sent an email or charged a card is not
something the UI should do silently.

When the agent hits a step requiring approval, the human-approval
panel appears inline in the timeline at that step (not a modal
stealing focus from the rest of the run) — draft, Reject / Edit /
Approve. Once resolved, the row collapses to a one-line summary:
"approved (edited)" with a click-through to see what changed.

### 3.4 Evaluations
Two parts, not a benchmark IDE. The split between them is the split
between *completion* and *correctness*: production runs have no ground
truth, so they can only be measured on whether the agent finished and
what it cost. Eval tasks carry an expected output, so they can be
measured on whether it was right. Keeping these in separate surfaces
stops a liveness metric from being read as an accuracy metric.

- **Aggregate card row** (4 numbers max, trailing 30 days of production
  runs): task-completion rate, avg latency, human-correction rate,
  avg cost per run. No "success rate" — with no ground truth behind it
  the number was either a duplicate of task-completion or undefined.
- **Run an eval set**: pick a task set, run N tasks. Each task carries
  an `input` and an optional `expected_output` plus an assertion kind
  (`exact` / `contains` / `json_subset` / `llm_judge`; `none` for tasks
  that are only liveness checks). Results come back on two axes:
  - *Did it finish?* — completed / needed intervention / failed
  - *Was it right?* — passed / failed assertion / not asserted

  Plus avg latency, avg tool calls, and avg cost. A table underneath,
  one row per task, shows both axes and links to its run trace.

### 3.5 Workflows
A workflow is a saved run, shown as its step sequence (read-only) plus
metadata: source run, agent version pinned, input schema. Actions:
"Run again" (form matching the input schema) and "Copy API endpoint"
(`POST /api/workflows/:id/run`). No visual workflow *builder* in MVP —
workflows are captured from successful runs, not constructed from
scratch on a canvas (that's the Synthex-style complexity we're
deliberately avoiding).

### 3.6 Versions
Simple list: v1/v2/v3, each with created date, model, and a
production/archived tag. One version is "production" at a time.
Every run record pins agent version + tool definitions version +
workflow version, so any run can say exactly what produced it.

---

## 4. Data model

Three rules the schema exists to enforce:

1. **Traces are immutable.** Steps are append-only. Retries and replays
   add rows; they never overwrite them.
2. **Every run can say exactly what produced it.** Runs pin an agent
   version, which pins exact tool-definition versions.
3. **Every row is tenant-scoped from migration #1.** `organization_id`
   everywhere, plus one scoping helper that every query goes through —
   even while there's a single hardcoded org. Retrofitting a tenant
   column across every query later is pure tax.

```sql
Organization   id, name, created_at
User           id, organization_id, email, created_at
ApiKey         id, organization_id, name, key_hash, last_used_at, revoked_at
               -- one scoped key per org; authenticates POST /api/workflows/:id/run

Agent          id, organization_id, name, description,
               production_version_id -> AgentVersion (nullable)

AgentVersion   id, organization_id, agent_id, version_no,
               model, system_instructions,
               max_steps, timeout_ms, max_retries,
               require_approval_for_side_effecting (bool),
               created_at, archived_at
               -- immutable once any Run references it; new config = new row,
               --    not a copied Agent

ToolDefinition id, organization_id (null = built-in), key, version,
               display_name, json_schema,
               side_effecting (bool), credential_ref (nullable),
               created_at
               -- unique (key, version), rows immutable. Exists in MVP even
               --    though there's no registry UI: runs must be able to pin
               --    a tool version regardless of whether users can browse one.

AgentVersionTool  agent_version_id, tool_definition_id
               -- pins the exact tool version, not just the tool

Run            id, organization_id, agent_version_id, workflow_id (nullable),
               status: queued | running | awaiting_approval | completed
                       | failed | cancelled | timed_out,
               input (jsonb), output (jsonb, nullable),
               error_type (nullable), error_detail (nullable),
               started_at, ended_at, duration_ms,
               tokens_in, tokens_out, cost_usd,
               replayed_from_run_id (nullable),
               replayed_from_step_ordinal (nullable),
               lease_owner, lease_expires_at
               -- lease_* is the worker claim: a crashed worker's runs become
               --    reclaimable once the lease expires

Step           id, organization_id, run_id,
               ordinal (int), attempt (int, default 1),
               type: thought | tool_call | tool_result | approval
                     | warning | completion,
               tool_definition_id (nullable),
               arguments (jsonb), result (jsonb),      -- secrets redacted before write
               status: ok | error | rejected | superseded,
               error_type, error_detail,
               approval_state: pending | approved | approved_edited | rejected,
               approved_by_user_id, approval_edit (jsonb),
               tokens_in, tokens_out, cost_usd,
               started_at, ended_at, duration_ms
               -- unique (run_id, ordinal, attempt). Append-only; the single
               --    mutable field is approval_state resolving from pending.
               -- attempt is why retries can render honestly: two attempts of
               --    step 4 are two rows, not one row that changed its mind.

Workflow       id, organization_id, name, source_run_id,
               agent_version_id (pinned), input_schema (jsonb), created_at

EvalSet        id, organization_id, agent_id, name, created_at
EvalTask       id, organization_id, eval_set_id, name,
               input (jsonb), expected_output (jsonb, nullable),
               assertion: none | exact | contains | json_subset | llm_judge
EvalRun        id, organization_id, eval_set_id, agent_version_id,
               started_at, ended_at,
               n_completed, n_intervened, n_failed,
               n_passed, n_failed_assertion, n_not_asserted
EvalTaskResult id, organization_id, eval_run_id, eval_task_id, run_id,
               outcome: completed | intervened | failed,
               assertion_result: passed | failed | skipped,
               latency_ms, tool_calls, cost_usd
```

No RBAC in MVP — one role (member). The tenant boundary is demonstrated
by `organization_id` scoping plus the per-org API key, not by a role
system; RBAC is a stated next step, not built.

---

## 5. Visual design principles

- **Neutral base, single accent.** Gray/white surfaces; one accent
  color for primary actions; green/amber/red *only* for status, never
  decoratively.
- **No dashboard clutter.** Stat cards, sparklines, and donut charts
  are earned, not default — add them only where a number needs a
  trend, not as a layout filler.
- **One primary action per screen.** Run button, Save button, Approve
  button — never two competing calls to action.
- **Flat surfaces.** No gradients, no glow, no drop shadows beyond a
  hairline border. Status communicated by a small colored dot or
  label, not a tinted glowing icon circle.
- **Monospace for machine data.** Timestamps, span IDs, JSON payloads,
  API paths — monospace. Everything else — sans.
- **Progressive disclosure.** Execution limits, version diffs, and
  raw JSON are one click away, not on-screen by default.

---

## 6. MVP phasing

The ordering rule: **later phases add capability, they never rewrite the
execution core.** A run that suspends on approval and resumes minutes
later cannot be an in-memory loop with async bolted on afterward — so
the durable state machine is Phase 1 work even though the features that
depend on it (SSE, replay, human-in-the-loop) ship in Phases 2–3.

**Phase 1 — Execution core, durable from the start**
- Agent CRUD writing `AgentVersion` rows; tool attachment pinning
  `ToolDefinition` versions.
- A run is a **persisted state machine**, not a call stack. A worker
  claims a queued run by lease, then loops: read run state from
  Postgres → advance one step → persist the step → repeat. Nothing
  about a run's progress lives only in process memory, so a killed
  worker resumes from the last persisted step and a run completes
  whether or not anyone is watching it.
- `awaiting_approval` is in the status enum from migration #1, unused
  until Phase 3. Phase 3 then makes it *reachable* rather than making
  it *possible*.
- Bounded execution enforced in the tool dispatcher: max steps, per-tool
  timeout, retries persisted as new `Step` attempts.
- `organization_id` + the scoping helper in migration #1, one hardcoded org.
- Run history list, trace timeline + inspector (polled; SSE arrives in
  Phase 2 as a transport swap, not a re-architecture).

**Phase 2 — Platform primitives**
- Save run → Workflow; workflow re-run against the pinned agent version.
- Agent versioning UI: list, diff, promote to production.
- SSE trace updates — one event per persisted step, replacing polling.
- Replay-from-step → new Run with `replayed_from_*`, halting at the
  first side-effecting step. Cached-output (deterministic) replay stays
  a stated stretch goal.

**Phase 3 — Product surface**
- Human-in-the-loop: the inline approval panel in the trace. Approve /
  edit / reject writes the resolution onto the Step and releases the run
  back to the worker queue — the suspend/resume machinery already exists.
- Org/workspace switcher and the per-org API key.
- 3-item nav polish.
- Evaluations tab: aggregate row + eval-set runner with assertions.

**Phase 4 — Engineering polish**
Tests, structured logging, rate limits, API docs, Docker, one
architecture diagram, README demo script.

---

## 7. Technical decisions

1. **Stack — decide before anything below.** Language/framework, and
   the worker mechanism that advances runs. Everything in §6 assumes
   Postgres for both persistence and run queueing (lease columns on
   `Run`, claimed by a polling worker) rather than a separate broker;
   one fewer moving part for an MVP. The LLM provider sits behind a
   thin interface so the model field on `AgentVersion` isn't tied to
   one vendor's SDK.
2. **Live trace updates:** SSE, one event per persisted step. Reconnect
   sends `Last-Event-ID` = last step ordinal received; the server
   replays from that ordinal out of Postgres. The stream is a *view
   onto persisted steps*, never the thing driving execution — closing
   the browser does not affect the run. Disable proxy buffering
   (`X-Accel-Buffering: no`) or streams arrive in chunks.
3. **Replay semantics:** replay from step N creates a new Run
   (`replayed_from_run_id` + `replayed_from_step_ordinal`) with live
   tool calls against the same agent version and inputs. It **halts at
   the first side-effecting step** and requires explicit approval
   before proceeding — otherwise replay silently re-sends the email or
   re-charges the card. Cached-output (deterministic) replay needs full
   step snapshots; deferred.
4. **Tool execution and dispatch:** all tool calls go through a single
   dispatcher with a uniform timeout and retry wrapper, so limits
   behave identically across tool types and each retry lands as a new
   `Step` attempt.
5. **Auth:** one scoped API key per organization, hashed at rest,
   authenticating `POST /api/workflows/:id/run`. Without it that
   endpoint is an unauthenticated way to spend money, and the
   multi-tenant boundary is asserted rather than demonstrated. No RBAC.
6. **Error taxonomy:** `model_error | tool_error | timeout |
   max_steps_exceeded | approval_rejected | internal`, stored on both
   Run and Step. The trace renders these distinctly — "the model
   returned nonsense" and "the tool timed out" are different failures
   and the inspector shouldn't flatten them into one red icon.
7. **Secrets:** tool credentials live in env/secret storage and are
   referenced by `credential_ref` on `ToolDefinition` — never in agent
   config rows, never in persisted step payloads. Redact before write,
   not before render.
8. **Concurrency:** cap concurrent running runs per organization;
   excess stays `queued`. Cheap to add given runs are already queued
   rows, and it prevents one workspace from starving the worker pool.
9. **Metric windows:** dashboard and aggregate metrics are computed
   over a trailing 30 days, stated in the UI rather than left implicit.

<img width="797" height="446" alt="Screenshot 2026-09-12 at 11 51 26 AM" src="https://github.com/user-attachments/assets/f6c73270-f6de-4543-87bf-119e30946ab5" />
<img width="759" height="522" alt="Screenshot 2026-09-12 at 11 57 05 AM" src="https://github.com/user-attachments/assets/81ab6d7d-d87e-4f66-9be6-5ee3f5caf2b0" />
<img width="794" height="407" alt="Screenshot 2026-09-12 at 11 58 05 AM" src="https://github.com/user-attachments/assets/052ee8c9-ebed-4ead-8327-b793194d7bd5" />
