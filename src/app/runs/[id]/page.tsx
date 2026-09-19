import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTraceView } from "@/server/trace";
import { TraceUi } from "./trace-view";
import { SaveAsWorkflow } from "./save-workflow";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await loadTraceView(id);
  if (!view) notFound();

  return (
    <>
      <div className="mb-4">
        <Link
          href={`/agents/${view.agent.id}/runs`}
          className="text-xs text-ink-muted hover:text-ink"
        >
          ← {view.agent.name}
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">
          {view.run.label ?? "Run"}
        </h1>
      </div>

      <TraceUi initial={view} />

      {/* Workflows are captured from *successful* runs (§3.5), so the
          affordance only exists once there is something worth reusing. */}
      {view.run.status === "completed" ? (
        <div className="mt-6 flex flex-wrap items-start gap-3 rounded border border-line px-4 py-3">
          <SaveAsWorkflow
            runId={view.run.id}
            task={view.run.task}
            suggestedName={view.run.label ?? view.agent.name}
          />
        </div>
      ) : null}
    </>
  );
}
