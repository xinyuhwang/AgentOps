import type { RunStatus } from "@/db/schema";

/**
 * §5 — status is a small coloured dot or a label, never a tinted glowing icon
 * circle. Colour appears here and nowhere else.
 */
const STATUS_COLOR: Record<RunStatus | "draft" | "production", string> = {
  queued: "var(--color-status-idle)",
  running: "var(--color-accent)",
  awaiting_approval: "var(--color-status-warn)",
  completed: "var(--color-status-ok)",
  failed: "var(--color-status-bad)",
  cancelled: "var(--color-status-idle)",
  timed_out: "var(--color-status-bad)",
  draft: "var(--color-status-idle)",
  production: "var(--color-status-ok)",
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

export function StatusDot({
  status,
}: {
  status: RunStatus | "draft" | "production";
}) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: STATUS_COLOR[status] }}
    />
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
        ) : null}
      </div>
      {/* One primary action per screen (§5). */}
      {action}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
      {children}
    </h2>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-line px-4 py-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCost(costUsd: string | number | null): string {
  const n = Number(costUsd ?? 0);
  if (!Number.isFinite(n) || n === 0) return "—";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatRelative(date: Date | null): string {
  if (!date) return "never";
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function formatClock(date: Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
