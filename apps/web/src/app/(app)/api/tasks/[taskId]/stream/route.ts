import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md).
 * Browser-facing half of the streaming proxy chain: authenticates the
 * request, then relays tick's own /tasks/:taskId/stream through as SSE. Tick
 * holds all Managed Agents credentials — this route never sees them.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  await withAuth();
  const { taskId } = await params;

  const streamUnavailable = (status: number) =>
    new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  let upstream: Response;
  try {
    upstream = await fetch(`${env.TICK_INTERNAL_URL}/tasks/${taskId}/stream`);
  } catch {
    return streamUnavailable(502);
  }

  if (!upstream.ok || !upstream.body) {
    // Tick returns 404 both when the task doesn't exist and when it exists
    // but has no sessionId yet (e.g. still `queued`). The latter is the
    // realistic case here — the browser only ever calls this with a real
    // task id it already has from a real page — and EventSource does NOT
    // auto-retry non-5xx statuses, so relaying a bare 404 would strand the
    // client forever even once dispatch happens and a session shows up.
    // Map it to a retryable 503 so the client's EventSource keeps polling
    // until the session is live. Other non-ok statuses are relayed as-is.
    if (upstream.status === 404) {
      return streamUnavailable(503);
    }
    return streamUnavailable(upstream.status || 502);
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
