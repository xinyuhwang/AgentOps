import Link from "next/link";
import { agentVersionList } from "@/server/queries";
import { archiveAgentVersion, promoteAgentVersion } from "@/server/actions";
import { Empty, StatusDot, formatRelative } from "@/app/_components/ui";

export const dynamic = "force-dynamic";

/**
 * §3.6 — a simple list: version number, created date, model, and a
 * production/archived tag. One version is production at a time.
 */
export default async function AgentVersionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const versions = await agentVersionList(id);

  if (versions.length === 0) {
    return <Empty>This agent has no versions yet.</Empty>;
  }

  const production = versions.find((v) => v.isProduction);

  return (
    <>
      <ul className="divide-y divide-line rounded border border-line">
        {versions.map((version) => (
          <li
            key={version.id}
            className={`flex items-center gap-3 px-4 py-3 text-sm ${
              version.archivedAt ? "text-ink-muted" : ""
            }`}
          >
            <StatusDot status={version.isProduction ? "production" : "draft"} />
            <span className="machine w-8 font-medium">v{version.versionNo}</span>

            <div className="min-w-0 flex-1">
              <div className="machine truncate text-xs">{version.model}</div>
              <div className="text-xs text-ink-faint">
                {formatRelative(version.createdAt)} ·{" "}
                {/* Runs are the evidence behind a version. Zero means this
                    config has never actually been exercised. */}
                {version.runCount === 0
                  ? "no runs"
                  : `${version.runCount} run${version.runCount === 1 ? "" : "s"}`}
                {version.toolKeys.length > 0
                  ? ` · ${version.toolKeys.length} tool${version.toolKeys.length === 1 ? "" : "s"}`
                  : " · no tools"}
              </div>
            </div>

            {version.isProduction ? (
              <span className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide">
                production
              </span>
            ) : version.archivedAt ? (
              <span className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                archived
              </span>
            ) : null}

            {production && version.id !== production.id ? (
              <Link
                href={`/agents/${id}/versions/${version.versionNo}`}
                className="text-xs text-ink-muted hover:text-ink"
              >
                Diff
              </Link>
            ) : null}

            {!version.isProduction && !version.archivedAt ? (
              <form action={promoteAgentVersion.bind(null, id, version.id)}>
                <button
                  type="submit"
                  className="rounded border border-line-strong px-2 py-1 text-xs transition-colors hover:bg-surface-sunken"
                >
                  Promote
                </button>
              </form>
            ) : null}

            {!version.isProduction ? (
              <form
                action={archiveAgentVersion.bind(
                  null,
                  id,
                  version.id,
                  !version.archivedAt,
                )}
              >
                <button
                  type="submit"
                  className="text-xs text-ink-faint hover:text-ink"
                >
                  {version.archivedAt ? "Unarchive" : "Archive"}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-ink-faint">
        Archiving hides a version from the Overview form; it never deletes it,
        because runs keep pointing at the exact config that produced them.
      </p>
    </>
  );
}
