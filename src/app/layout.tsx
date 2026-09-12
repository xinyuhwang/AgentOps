import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentOps",
  description: "Build, run and observe AI agents.",
};

/**
 * §2 — flat, three-item primary nav. Depth lives inside each agent, not in the
 * global sidebar. The workspace switcher sits next to the user menu because it
 * changes which organization's data every screen shows; it is not a page.
 */
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/workflows", label: "Workflows" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-ink">
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-5xl items-center gap-8 px-6 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              AgentOps
            </Link>
            <nav className="flex items-center gap-6 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm text-ink-muted">
              <span className="rounded border border-line px-2 py-1 text-xs">
                Acme
              </span>
              <span className="text-xs">member@acme.test</span>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
