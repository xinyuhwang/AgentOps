import { NextResponse } from "next/server";
import { loadTraceView } from "@/server/trace";

/**
 * A one-shot JSON snapshot of a run's trace.
 *
 * The UI no longer polls this — it server-renders the first paint and then
 * follows `../stream` over SSE. This stays as a plain read API for scripts and
 * debugging, and it shares its shape with the stream via `loadTraceView`, so
 * the two cannot drift.
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
