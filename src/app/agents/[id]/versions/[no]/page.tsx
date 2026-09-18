import Link from "next/link";
import { notFound } from "next/navigation";
import { agentVersionList, type VersionRow } from "@/server/queries";
import { diffFields, diffLines, hasChanges } from "@/core/agents/diff";
import { Empty } from "@/app/_components/ui";

export const dynamic = "force-dynamic";

function toConfig(v: VersionRow) {
  return {
    model: v.model,
    maxSteps: v.maxSteps,
    timeoutMs: v.timeoutMs,
    maxRetries: v.maxRetries,
    requireApprovalForSideEffecting: v.requireApprovalForSideEffecting,
    toolKeys: v.toolKeys,
  };
}

/**
 * Diff against production, which is the comparison that actually matters:
 * "what would change if I promoted this". An arbitrary two-version picker
 * would be more general and less useful.
 */
export default async function VersionDiffPage({
  params,
}: {
  params: Promise<{ id: string; no: string }>;
}) {
  const { id, no } = await params;
  const versions = await agentVersionList(id);

  const subject = versions.find((v) => String(v.versionNo) === no);
  if (!subject) notFound();

  const production = versions.find((v) => v.isProduction);
  if (!production) {
    return <Empty>This agent has no production version to compare against.</Empty>;
  }

  const fields = diffFields(toConfig(production), toConfig(subject));
  const instructions = diffLines(
    production.systemInstructions,
    subject.systemInstructions,
  );
  const instructionsChanged = hasChanges(instructions);
  const anyFieldChanged = fields.some((f) => f.changed);

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link
          href={`/agents/${id}/versions`}
          className="text-xs text-ink-muted hover:text-ink"
        >
          ← Versions
        </Link>
      </div>

      <h2 className="mb-1 text-sm font-medium">
        <span className="machine">v{subject.versionNo}</span> compared with
        production <span className="machine">v{production.versionNo}</span>
      </h2>
      <p className="mb-6 text-xs text-ink-faint">
        Left is production, right is v{subject.versionNo}.
      </p>

      {!anyFieldChanged && !instructionsChanged ? (
        <Empty>These two versions are identical.</Empty>
      ) : null}

      {anyFieldChanged ? (
        <section className="mb-8">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
            Configuration
          </h3>
          <table className="w-full border border-line text-sm">
            <tbody>
              {fields
                .filter((f) => f.changed)
                .map((f) => (
                  <tr key={f.label} className="border-b border-line last:border-0">
                    <td className="w-48 px-3 py-2 text-xs text-ink-muted">
                      {f.label}
                    </td>
                    <td className="machine px-3 py-2 text-xs text-status-bad">
                      {f.before}
                    </td>
                    <td className="machine px-3 py-2 text-xs text-status-ok">
                      {f.after}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {instructionsChanged ? (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
            System instructions
          </h3>
          <pre className="machine overflow-x-auto rounded border border-line text-xs leading-relaxed">
            {instructions.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === "added"
                    ? "bg-surface-sunken px-3 text-status-ok"
                    : line.kind === "removed"
                      ? "bg-surface-sunken px-3 text-status-bad"
                      : "px-3 text-ink-muted"
                }
              >
                {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                {" "}
                {line.text || " "}
              </div>
            ))}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
