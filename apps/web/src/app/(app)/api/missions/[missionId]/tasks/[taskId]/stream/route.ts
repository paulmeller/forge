import { env } from '@/lib/env';
import { getTask } from '@/lib/tasks';
import { withAuth } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md),
 * consolidated (2026-07-19 spec §B): the old web→tick→Anthropic proxy chain is
 * now a single in-process hop — DB lookup, then a raw fetch to the Managed
 * Agents engine's session event stream. withAuth() is retained: this route is
 * browser-facing and fronts a raw x-api-key call.
 *
 * Task-missing, no-session-yet, belonging-to-someone-else, and belonging to a
 * different mission than the URL claims all map to 503 (not 404): EventSource
 * does not auto-retry non-5xx, and the browser only asks about real task ids —
 * a 404 would strand the client forever even once dispatch creates a session.
 * Every rejection shares that one path so a task id's existence, owner, and
 * mission aren't observable by probing. getTask() is scoped by userId
 * precisely so this route can't forget the ownership half.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ missionId: string; taskId: string }> },
) {
  const user = await withAuth();
  const { missionId, taskId } = await params;

  const streamUnavailable = (status: number) =>
    new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const task = await getTask(taskId, user.id);
  // The missionId in the path must actually own this task — otherwise the
  // nesting would be decorative, and /missions/<any>/tasks/<id>/stream would
  // serve a task the URL misdescribes.
  if (!task || task.missionId !== missionId || !task.sessionId) return streamUnavailable(503);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${env.ANTHROPIC_BASE_URL}/v1/sessions/${task.sessionId}/events/stream`,
      {
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
      },
    );
  } catch {
    return streamUnavailable(502);
  }

  if (!upstream.ok || !upstream.body) {
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
