import Link from "next/link";
import { listAgents, recentRuns, METRIC_WINDOW_DAYS } from "@/server/queries";
import {
  Empty,
  PageHeader,
  SectionTitle,
  StatusDot,
  STATUS_LABEL,
  formatCost,
  formatDuration,
  formatPercent,
  formatRelative,
} from "./_components/ui";

export const dynamic = "force-dynamic";

/**
 * §3.1 — "what's happening right now", two things only. No stat-card row, no
 * charts. If a number matters enough to headline it belongs in the agent's own
 * Evaluations tab, not duplicated here.
 */
export default async function DashboardPage() {
  const [agents, runs] = await Promise.all([listAgents(), recentRuns()]);

  return (
    <>
      <PageHeader title="Dashboard" />

      <section className="mb-10">
        <SectionTitle>Agents</SectionTitle>
        {agents.length === 0 ? (
          <Empty>
            No agents yet. <Link href="/agents" className="text-accent">Create one</Link>.
          </Empty>
        ) : (
          <ul className="divide-y divide-line rounded border border-line">
            {agents.map((agent) => (
              <li key={agent.id}>
                <Link
                  href={`/agents/${agent.id}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-sunken"
                >
                  <StatusDot status={agent.status} />
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-xs text-ink-faint">{agent.status}</span>
                  <span className="ml-auto flex items-center gap-6 text-xs text-ink-muted">
                    <span>{formatRelative(agent.lastRunAt)}</span>
                    <span className="machine w-10 text-right">
                      {formatPercent(agent.completionRate)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-faint">
          Completion rate over the trailing {METRIC_WINDOW_DAYS} days.
        </p>
      </section>

      <section>
        <SectionTitle>Recent runs</SectionTitle>
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded border border-line">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/runs/${run.id}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-sunken"
                >
                  <StatusDot status={run.status} />
                  <span className="truncate font-medium">{run.label}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {run.agentName}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-6 text-xs text-ink-muted">
                    <span>{STATUS_LABEL[run.status]}</span>
                    <span className="machine w-14 text-right">
                      {formatDuration(run.durationMs)}
                    </span>
                    <span className="machine w-16 text-right">
                      {formatCost(run.costUsd)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
