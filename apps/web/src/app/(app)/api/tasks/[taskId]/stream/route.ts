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

  const upstream = await fetch(`${env.TICK_INTERNAL_URL}/tasks/${taskId}/stream`);

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status: upstream.status || 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
