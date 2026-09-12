import Link from "next/link";
import { listAgents, METRIC_WINDOW_DAYS } from "@/server/queries";
import { createAgent } from "@/server/actions";
import {
  Empty,
  PageHeader,
  StatusDot,
  formatPercent,
  formatRelative,
} from "../_components/ui";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await listAgents();

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`Completion rate over the trailing ${METRIC_WINDOW_DAYS} days.`}
      />

      {agents.length === 0 ? (
        <Empty>No agents yet.</Empty>
      ) : (
        <ul className="mb-10 divide-y divide-line rounded border border-line">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/agents/${agent.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-sunken"
              >
                <StatusDot status={agent.status} />
                <div className="min-w-0">
                  <div className="font-medium">{agent.name}</div>
                  {agent.description ? (
                    <div className="truncate text-xs text-ink-muted">
                      {agent.description}
                    </div>
                  ) : null}
                </div>
                <span className="ml-auto flex shrink-0 items-center gap-6 text-xs text-ink-muted">
                  <span className="machine">{agent.model ?? "—"}</span>
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

      <form action={createAgent} className="max-w-md rounded border border-line p-4">
        <h2 className="mb-3 text-sm font-medium">New agent</h2>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-ink-muted">Name</span>
          <input
            name="name"
            required
            className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-ink-muted">Description</span>
          <input
            name="description"
            className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink"
        >
          Create agent
        </button>
      </form>
    </>
  );
}
