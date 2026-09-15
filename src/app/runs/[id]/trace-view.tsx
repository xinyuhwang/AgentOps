"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import type { TraceAgent, TraceRun, TraceStep, TraceView } from "@/server/trace";
import { decideApproval } from "@/server/actions";
import {
  StatusDot,
  STATUS_LABEL,
  formatCost,
  formatDuration,
} from "@/app/_components/ui";

const STEP_GLYPH: Record<TraceStep["type"], string> = {
  thought: "◇",
  tool_call: "→",
  tool_result: "←",
  approval: "!",
  warning: "△",
  completion: "●",
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

/**
 * §3.3 — the centerpiece. Three columns: timeline, inspector, status bar.
 */
export function TraceUi({ initial }: { initial: TraceView }) {
  const [view, setView] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.steps[0]?.id ?? null,
  );
  const [live, setLive] = useState(false);

  const runId = initial.run.id;
  const alreadyFinished = TERMINAL.has(initial.run.status);

  // Captured once. Deriving this inline would make the effect's dependency a
  // fresh array on every parent re-render, tearing the stream down and
  // rebuilding it — including after an approval revalidates this page.
  const [initialCursor] = useState(() => {
    const last = initial.steps.at(-1);
    return last ? `${last.ordinal}-${last.attempt}` : null;
  });

  /**
   * One event per persisted step, over SSE. The run advances in the worker
   * regardless — closing this tab does not affect it, and reopening resumes
   * from whatever the timeline is missing.
   */
  useEffect(() => {
    if (alreadyFinished) return;

    // Resume from the last step already rendered, so a reconnect does not
    // resend the whole trace. EventSource also sends Last-Event-ID itself once
    // it has seen an event, which covers mid-stream drops.
    const from = initialCursor ? `?from=${initialCursor}` : "";
    const source = new EventSource(`/api/runs/${runId}/stream${from}`);

    source.addEventListener("open", () => setLive(true));

    source.addEventListener("run", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        run: TraceRun;
        agent: TraceAgent;
      };
      setView((prev) => ({ ...prev, run: payload.run, agent: payload.agent }));
    });

    source.addEventListener("step", (event) => {
      const step = JSON.parse((event as MessageEvent).data) as TraceStep;
      setView((prev) => {
        // Steps are append-only, but a reconnect can legitimately redeliver the
        // event that was in flight when the connection dropped.
        if (prev.steps.some((s) => s.id === step.id)) return prev;
        return { ...prev, steps: [...prev.steps, step] };
      });
      setSelectedId((current) => current ?? step.id);
    });

    source.addEventListener("done", () => {
      setLive(false);
      source.close();
    });

    source.addEventListener("error", () => {
      // EventSource reconnects on its own; reflect the gap rather than hiding it.
      setLive(false);
    });

    return () => {
      source.close();
      setLive(false);
    };
    // Intentionally keyed only on the run: re-running this on every status
    // change would tear down and rebuild the stream mid-run.
  }, [runId, alreadyFinished, initialCursor]);

  const selected =
    view.steps.find((s) => s.id === selectedId) ?? view.steps[0] ?? null;

  return (
    <div className="space-y-4">
      <StatusBar view={view} live={live} />

      <div className="grid grid-cols-[1fr_20rem] gap-4">
        <Timeline
          view={view}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
        <Inspector step={selected} />
      </div>
    </div>
  );
}

function StatusBar({ view, live }: { view: TraceView; live: boolean }) {
  const { run } = view;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-line px-4 py-3 text-xs">
      <span className="flex items-center gap-2">
        <StatusDot status={run.status} />
        <span className="font-medium">{STATUS_LABEL[run.status]}</span>
        {/* Shown rather than hidden: if the stream drops, the timeline is
            stale and the user should know that, not guess it. */}
        {live ? <span className="text-ink-faint">· live</span> : null}
      </span>
      <span className="machine text-ink-faint">{run.id}</span>
      <span className="text-ink-muted">
        {view.agent.name} · v{view.agent.versionNo}
      </span>
      <span className="machine text-ink-muted">{view.agent.model}</span>
      <span className="ml-auto flex items-center gap-6 text-ink-muted">
        <span className="machine">{formatDuration(run.durationMs)}</span>
        <span className="machine">
          {run.tokensIn}/{run.tokensOut} tok
        </span>
        <span className="machine">{formatCost(run.costUsd)}</span>
      </span>
      {run.replayedFromRunId ? (
        <span className="w-full text-ink-muted">
          Replay of{" "}
          <Link
            href={`/runs/${run.replayedFromRunId}`}
            className="machine text-accent"
          >
            {run.replayedFromRunId.slice(0, 8)}
          </Link>{" "}
          from step {run.replayedFromStepOrdinal}
        </span>
      ) : null}
      {run.errorType ? (
        <span className="w-full text-status-bad">
          {run.errorType}: {run.errorDetail}
        </span>
      ) : null}
    </div>
  );
}

function Timeline({
  view,
  selectedId,
  onSelect,
}: {
  view: TraceView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (view.steps.length === 0) {
    return (
      <div className="rounded border border-line px-4 py-8 text-center text-sm text-ink-muted">
        Waiting for a worker to pick this run up.
      </div>
    );
  }

  return (
    <ol className="divide-y divide-line rounded border border-line">
      {view.steps.map((step) => (
        <li key={step.id}>
          <button
            onClick={() => onSelect(step.id)}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-sunken ${
              step.id === selectedId ? "bg-surface-sunken" : ""
            }`}
          >
            <span className="machine w-6 shrink-0 text-xs text-ink-faint">
              {step.ordinal}
            </span>
            <span
              aria-hidden
              className="w-4 shrink-0 text-center text-xs"
              style={{
                color:
                  step.status === "error"
                    ? "var(--color-status-bad)"
                    : step.type === "approval"
                      ? "var(--color-status-warn)"
                      : "var(--color-ink-faint)",
              }}
            >
              {STEP_GLYPH[step.type]}
            </span>
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            {step.attempt > 1 ? (
              <span className="machine shrink-0 text-xs text-ink-faint">
                attempt {step.attempt}
              </span>
            ) : null}
            <span className="machine w-14 shrink-0 text-right text-xs text-ink-faint">
              {formatDuration(step.durationMs)}
            </span>
          </button>

          {/* §3.3 — the approval panel appears inline at its step, not in a
              modal that steals focus from the rest of the run. */}
          {step.type === "approval" ? (
            <ApprovalPanel step={step} runId={view.run.id} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ApprovalPanel({ step, runId }: { step: TraceStep; runId: string }) {
  const [pending, startTransition] = useTransition();

  if (step.approvalState !== "pending") {
    // Resolved rows collapse to a one-line summary.
    return (
      <div className="border-t border-line bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
        {step.approvalState === "rejected"
          ? "rejected"
          : step.approvalState === "approved_edited"
            ? "approved (edited)"
            : "approved"}
      </div>
    );
  }

  const calls =
    (step.arguments as { toolCalls?: Array<{ toolKey: string }> } | null)
      ?.toolCalls ?? [];

  return (
    <div className="border-t border-line bg-surface-sunken px-3 py-3">
      <p className="mb-2 text-xs text-ink-muted">
        This run is paused. It will not proceed until someone decides — the
        worker has already let go of it.
      </p>
      <pre className="machine mb-3 overflow-x-auto rounded border border-line bg-surface p-2 text-xs">
        {JSON.stringify(calls, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() =>
            startTransition(() => {
              void decideApproval(step.id, runId, "approve");
            })
          }
          className="rounded bg-accent px-3 py-1 text-xs text-accent-ink disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={pending}
          onClick={() =>
            startTransition(() => {
              void decideApproval(step.id, runId, "reject");
            })
          }
          className="rounded border border-line-strong px-3 py-1 text-xs disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function Inspector({ step }: { step: TraceStep | null }) {
  const [tab, setTab] = useState<"overview" | "data" | "errors">("overview");

  if (!step) {
    return (
      <aside className="rounded border border-line px-3 py-4 text-sm text-ink-muted">
        Select a step.
      </aside>
    );
  }

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "data" as const, label: "Data" },
    ...(step.errorType ? [{ id: "errors" as const, label: "Errors" }] : []),
  ];

  return (
    <aside className="self-start rounded border border-line">
      <div className="flex gap-3 border-b border-line px-3 py-2 text-xs">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              tab === t.id ? "font-medium text-ink" : "text-ink-muted"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-3 py-3 text-xs">
        {tab === "overview" ? (
          <dl className="space-y-2">
            <Field label="Step" value={`${step.ordinal} · ${step.type}`} />
            <Field label="Label" value={step.label} mono={false} />
            <Field label="Attempt" value={String(step.attempt)} />
            <Field label="Status" value={step.status} />
            <Field label="Duration" value={formatDuration(step.durationMs)} />
            <Field
              label="Started"
              value={new Date(step.startedAt).toLocaleTimeString()}
            />
            {step.tool ? (
              <Field
                label="Tool"
                value={`${step.tool.key}${step.tool.sideEffecting ? " (side-effecting)" : ""}`}
              />
            ) : null}
          </dl>
        ) : null}

        {tab === "data" ? (
          <div className="space-y-3">
            <Json title="Arguments" value={step.arguments} />
            <Json title="Result" value={step.result} />
          </div>
        ) : null}

        {tab === "errors" ? (
          <div className="space-y-1">
            <div className="font-medium text-status-bad">{step.errorType}</div>
            <p className="text-ink-muted">{step.errorDetail}</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Field({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-faint">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "machine" : ""}`}>{value}</dd>
    </div>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <div className="mb-1 text-ink-faint">{title}</div>
      <pre className="machine overflow-x-auto rounded border border-line bg-surface-sunken p-2 text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
