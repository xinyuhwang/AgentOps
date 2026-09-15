import { currentScope } from "@/db/scope";
import { parseCursor } from "@/server/trace";
import { encodeComment, encodeSse, traceEvents } from "@/server/stream";

/** Streaming responses must not be collected or cached by the framework. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEARTBEAT_MS = 15_000;

/**
 * SSE trace updates (§7.2). One event per persisted step.
 *
 * Resumption uses the standard `Last-Event-ID` header, which the browser's
 * EventSource sends automatically on reconnect; `?from=` is accepted too so the
 * stream can be resumed by hand or by a non-browser client.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scope = await currentScope();

  const url = new URL(request.url);
  const cursor =
    parseCursor(request.headers.get("last-event-id")) ??
    parseCursor(url.searchParams.get("from"));

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // The client going away is the normal way this ends.
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(encodeComment("keep-alive")));
        } catch {
          // Stream already closed; the finally block below handles cleanup.
        }
      }, HEARTBEAT_MS);

      try {
        for await (const event of traceEvents(scope, id, cursor, {
          signal: abort.signal,
        })) {
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          controller.enqueue(
            encoder.encode(
              encodeSse({
                event: "error",
                data: { message: err instanceof Error ? err.message : "stream failed" },
              }),
            ),
          );
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, buffering proxies deliver the stream in chunks and the
      // trace appears to jump rather than fill in (§7.2).
      "X-Accel-Buffering": "no",
    },
  });
}
