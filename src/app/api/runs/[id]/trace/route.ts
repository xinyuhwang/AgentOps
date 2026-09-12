import { NextResponse } from "next/server";
import { loadTraceView } from "@/server/trace";

/**
 * Polled by the trace page while a run is in flight. Phase 2 replaces the
 * polling with SSE — one event per persisted step, resumable via
 * `Last-Event-ID` — but the payload shape stays the same, because the stream is
 * a view onto persisted steps rather than the thing driving execution.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const view = await loadTraceView(id);

  if (!view) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
