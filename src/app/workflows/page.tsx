import Link from "next/link";
import { currentScope } from "@/db/scope";
import { listWorkflows } from "@/core/workflows/service";
import { Empty, PageHeader, formatRelative } from "../_components/ui";

export const dynamic = "force-dynamic";

/**
 * §3.5 — workflows are captured from successful runs, not constructed from
 * scratch on a canvas. There is deliberately no "new workflow" button here:
 * you save one from a run's trace.
 */
export default async function WorkflowsPage() {
  const scope = await currentScope();
  const workflows = await listWorkflows(scope);

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="A saved run: its agent version pinned, plus the inputs it takes."
      />

      {workflows.length === 0 ? (
        <Empty>
          Nothing saved yet. Open a completed run and choose “Save as workflow”.
        </Empty>
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {workflows.map((workflow) => (
            <li key={workflow.id}>
              <Link
                href={`/workflows/${workflow.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-sunken"
              >
                <span className="font-medium">{workflow.name}</span>
                <span className="machine text-xs text-ink-faint">
                  {workflow.variables.length > 0
                    ? workflow.variables.map((v) => `{{${v}}}`).join(" ")
                    : "no inputs"}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-6 text-xs text-ink-muted">
                  <span>
                    {workflow.agentName} · v{workflow.versionNo}
                  </span>
                  <span>{formatRelative(workflow.createdAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
