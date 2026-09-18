import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgent } from "@/server/queries";
import { StatusDot } from "../../_components/ui";

/**
 * §2 — depth lives inside the agent. Evaluations (Phase 3) slots in here as a
 * further tab without touching the global nav.
 */
export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAgent(id);
  if (!data) notFound();

  const tabs = [
    { href: `/agents/${id}`, label: "Overview" },
    { href: `/agents/${id}/runs`, label: "Runs" },
    { href: `/agents/${id}/versions`, label: "Versions" },
  ];

  return (
    <>
      <div className="mb-1 flex items-center gap-2">
        <StatusDot
          status={data.agent.productionVersionId ? "production" : "draft"}
        />
        <h1 className="text-lg font-semibold tracking-tight">
          {data.agent.name}
        </h1>
        {data.production ? (
          <span className="machine text-xs text-ink-faint">
            v{data.production.versionNo}
          </span>
        ) : null}
      </div>
      {data.agent.description ? (
        <p className="mb-4 text-sm text-ink-muted">{data.agent.description}</p>
      ) : null}

      <nav className="mb-6 flex gap-4 border-b border-line text-sm">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="-mb-px border-b-2 border-transparent px-1 pb-2 text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </>
  );
}
