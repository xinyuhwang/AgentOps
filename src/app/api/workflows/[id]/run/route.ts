import { NextResponse } from "next/server";
import { scopeFromApiKey } from "@/db/scope";
import { runWorkflow } from "@/core/workflows/service";

export const dynamic = "force-dynamic";

/**
 * The copyable endpoint from §3.5.
 *
 * Authenticated with a per-organization API key (§7.5) rather than the session
 * that the UI uses: this is a machine endpoint, and without a key it would be
 * an unauthenticated way to spend money. The key also *is* the tenant — scope
 * comes from the key, so a key can only ever reach its own organization's
 * workflows.
 *
 *   curl -X POST https://host/api/workflows/<id>/run \
 *     -H "Authorization: Bearer ao_..." \
 *     -H "Content-Type: application/json" \
 *     -d '{"order_id": "1182"}'
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const scope = await scopeFromApiKey(request.headers.get("authorization"));
  if (!scope) {
    return NextResponse.json(
      { error: "Missing or invalid API key." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    // An empty body is a valid call for a workflow with no variables.
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const result = await runWorkflow(scope, id, body);

  if (!result.ok) {
    // A missing workflow and a bad input are different failures: one is 404,
    // the other is the caller's payload.
    const notFound = result.errors.some((e) => e.includes("not found"));
    return NextResponse.json(
      { error: notFound ? "Workflow not found." : "Invalid input.", details: result.errors },
      { status: notFound ? 404 : 400 },
    );
  }

  // 202: the run is queued, not finished. A worker picks it up, and the caller
  // follows the trace rather than blocking on a response.
  return NextResponse.json(
    {
      runId: result.runId,
      status: "queued",
      trace: `/api/runs/${result.runId}/trace`,
    },
    { status: 202 },
  );
}
