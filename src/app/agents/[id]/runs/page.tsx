import Link from "next/link";
import { agentRuns } from "@/server/queries";
import {
  Empty,
  StatusDot,
  STATUS_LABEL,
  formatCost,
  formatDuration,
  formatRelative,
} from "@/app/_components/ui";

export const dynamic = "force-dynamic";

export default async function AgentRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runs = await agentRuns(id);

  if (runs.length === 0) {
    return <Empty>No runs yet. Start one from the Overview tab.</Empty>;
  }

  return (
    <ul className="divide-y divide-line rounded border border-line">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            href={`/runs/${run.id}`}
            className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-sunken"
          >
            <StatusDot status={run.status} />
            <span className="truncate">{run.label}</span>
            <span className="machine shrink-0 text-xs text-ink-faint">
              v{run.versionNo}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-6 text-xs text-ink-muted">
              <span>{STATUS_LABEL[run.status]}</span>
              <span>{formatRelative(run.createdAt)}</span>
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
  );
}
