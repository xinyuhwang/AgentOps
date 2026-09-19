import Link from "next/link";
import { notFound } from "next/navigation";
import { currentScope } from "@/db/scope";
import { getWorkflow } from "@/core/workflows/service";
import { loadSteps } from "@/core/run/store";
import { SectionTitle, formatDuration } from "@/app/_components/ui";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";

/**
 * §3.5 — the saved run's step sequence (read-only) plus metadata, with two
 * actions: run again, and copy the API endpoint.
 */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await currentScope();
  const workflow = await getWorkflow(scope, id);
  if (!workflow) notFound();

  const steps = workflow.sourceRunId
    ? await loadSteps(workflow.sourceRunId)
    : [];

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold tracking-tight">{workflow.name}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Pinned to{" "}
        <Link href={`/agents/${workflow.agentId}`} className="text-accent">
          {workflow.agentName}
        </Link>{" "}
        <span className="machine">v{workflow.versionNo}</span> ·{" "}
        <span className="machine">{workflow.model}</span>
        {workflow.runCount > 0
          ? ` · ${workflow.runCount} run${workflow.runCount === 1 ? "" : "s"}`
          : null}
      </p>

      <section className="mt-8">
        <SectionTitle>Task template</SectionTitle>
        <pre className="machine overflow-x-auto rounded border border-line bg-surface-sunken p-3 text-xs">
          {workflow.spec.template}
        </pre>
      </section>

      <section className="mt-8">
        <SectionTitle>Run again</SectionTitle>
        <RunForm workflowId={workflow.id} variables={workflow.spec.variables} />
      </section>

      <section className="mt-8">
        <SectionTitle>API endpoint</SectionTitle>
        <pre className="machine overflow-x-auto rounded border border-line bg-surface-sunken p-3 text-[11px] leading-relaxed">
          {[
            `curl -X POST ${"{host}"}/api/workflows/${workflow.id}/run \\`,
            `  -H "Authorization: Bearer $AGENTOPS_API_KEY" \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -d '${JSON.stringify(
              Object.fromEntries(workflow.spec.variables.map((v) => [v, "…"])),
            )}'`,
          ].join("\n")}
        </pre>
        <p className="mt-2 text-xs text-ink-faint">
          Authenticated with your organization&rsquo;s API key. Returns 202 with
          a run id — the run is queued, not finished.
        </p>
      </section>

      <section className="mt-8">
        <SectionTitle>Steps</SectionTitle>
        {steps.length === 0 ? (
          <p className="text-xs text-ink-muted">
            The source run is no longer available.
          </p>
        ) : (
          <>
            <ol className="divide-y divide-line rounded border border-line">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="machine w-6 shrink-0 text-xs text-ink-faint">
                    {step.ordinal}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{step.label}</span>
                  <span className="machine shrink-0 text-xs text-ink-faint">
                    {formatDuration(step.durationMs)}
                  </span>
                </li>
              ))}
            </ol>
            {workflow.sourceRunId ? (
              <p className="mt-2 text-xs text-ink-faint">
                Captured from{" "}
                <Link
                  href={`/runs/${workflow.sourceRunId}`}
                  className="machine text-accent"
                >
                  {workflow.sourceRunId.slice(0, 8)}
                </Link>
                . Read-only — this is what the run did, not an editable diagram.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
