# AgentOps Design Doc

## 1. Vision

A small, polished platform for building, running, and observing AI agents.
The product should feel like a well-made tool, not a dashboard — every screen
shows exactly what's needed for the task at hand and nothing else. Think IKEA:
few parts, each one obviously considered, nothing decorative.

**Core loop:** Create agent → configure tools → define task → run →
inspect trace → approve/intervene → evaluate → save as workflow → reuse.

The trace inspector is the centerpiece. Everything else exists to feed it
data or act on what it shows.

---

## 2. Information architecture

Flat, three-item primary nav. Depth lives inside each agent, not in the
global sidebar.

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

No standalone "Tools" or "Runs" nav items in MVP. Tools are attached from
within Agent config; a global tool registry is a v2 feature once agents
share enough tools to need one. "Runs" lives under each agent rather than
as a cross-agent firehose — a recent-runs list on the Dashboard covers the
cross-agent view.

Workspace switcher (multi-tenancy) sits top-right, next to the user menu —
it changes *which organization's data* every other screen shows, it isn't
a page of its own.

---

## 3. Screens

### 3.1 Dashboard
Purpose: "what's happening right now." Two things only:
- **Agents** — name, status dot (draft / production), last run time, success rate. One row per agent, no cards with stats stacked on stats.
- **Recent runs** — task name, status icon, duration, agent. Click → run trace.

No stat-card row, no charts, no notification toasts layered on buttons.
If a number matters enough to headline, it goes in the agent's own
Evaluations tab, not duplicated here.

### 3.2 Agent detail — Overview (configure)
A single form, top to bottom, one column:
- Model selector
- System instructions (textarea)
- Tools (checkbox list — search, database, calculator, browser, etc.)
- Execution limits (max steps, timeout, retries) — collapsed under an
  "Execution" disclosure, since most users won't touch defaults
- Human approval toggle ("required before external actions")
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
- **Status bar** (top): run id, elapsed time, running/completed/failed,
  and — when relevant — a single "Replay from step N" action.

When the agent hits a step requiring approval, the human-approval
panel appears inline in the timeline at that step (not a modal
stealing focus from the rest of the run) — draft, Reject / Edit /
Approve. Once resolved, the row collapses to a one-line summary:
"approved (edited)" with a click-through to see what changed.

### 3.4 Evaluations
Two parts, not a benchmark IDE:
- **Aggregate card row** (4 numbers max): success rate, avg latency,
  human-correction rate, task-completion rate.
- **Run an eval set**: pick a task set, run N tasks, get three counts
  back — completed / needed intervention / failed — plus avg latency
  and avg tool calls. A table underneath, one row per task, links to
  its run trace.

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

## 4. Data model (minimal)

```
Organization
  └─ Users
  └─ Agents (versioned)
       └─ Tools attached (references shared Tool defs)
       └─ Runs
            └─ Steps (tool_call | thought | approval | completion)
       └─ Workflows (saved from a Run)
       └─ Evaluations (aggregate + eval-set results)
```

Every table carries `organization_id`. No separate auth system for
MVP — one role (member) is enough to demonstrate the multi-tenant
boundary; RBAC is a stated next step, not built.

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

## 6. MVP phasing (revised)

**Phase 1 — Execution core**
Agent CRUD, tool attachment, structured tool-calling loop, bounded
execution (max steps/timeout/retries), Postgres persistence, run
history list, trace timeline + inspector.

**Phase 2 — Platform primitives**
Save run → workflow, workflow re-run, agent versioning, async
execution (event-driven trace updates via SSE), replay-from-step
(live tool calls only for MVP — cached-output replay is a stated
stretch goal).

**Phase 3 — Product surface**
Human-in-the-loop inline in the trace, org/workspace model, 3-item
nav polish, evaluations tab (aggregate + eval-set runner).

**Phase 4 — Engineering polish**
Tests, structured logging, rate limits, API docs, Docker, one
architecture diagram, README demo script.

---

## 7. Open technical decisions to make before building

1. **Live trace updates:** SSE vs WebSocket vs polling — shapes
   whether steps are appended events or a re-fetched run object.
   Recommendation: SSE, one event per step; simplest to reason about
   and sufficient for single-viewer trace watching.
2. **Replay semantics:** MVP replays from step N with live tool
   calls against the same agent version and inputs. Cached-output
   replay (deterministic replay) requires storing full step
   snapshots — deferred to Phase 2 stretch.
3. **Tool execution sandboxing:** even for a demo, tool calls should
   run through a single dispatcher with a timeout wrapper, so retries
   and timeouts are uniform across tool types.

<img width="797" height="446" alt="Screenshot 2026-09-12 at 11 51 26 AM" src="https://github.com/user-attachments/assets/f6c73270-f6de-4543-87bf-119e30946ab5" />
<img width="759" height="522" alt="Screenshot 2026-09-12 at 11 57 05 AM" src="https://github.com/user-attachments/assets/81ab6d7d-d87e-4f66-9be6-5ee3f5caf2b0" />
<img width="794" height="407" alt="Screenshot 2026-09-12 at 11 58 05 AM" src="https://github.com/user-attachments/assets/052ee8c9-ebed-4ead-8327-b793194d7bd5" />
