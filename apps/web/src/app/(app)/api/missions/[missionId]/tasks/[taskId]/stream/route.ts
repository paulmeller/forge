import { missionBackend } from '@/lib/task-session-ops';
import { getTask } from '@/lib/tasks';
import { getOptionalUser } from '@/lib/with-auth';
import { getAdapter } from '@/server/tick/adapters';
import { AdapterNotImplementedError } from '@/server/tick/adapters/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md),
 * consolidated (2026-07-19 spec §B): the old web→tick→Anthropic proxy chain is
 * now a single in-process hop — DB lookup, then a raw fetch to the mission's
 * own backend's session event stream. Authentication is retained: this route
 * is browser-facing and fronts a raw x-api-key call.
 *
 * The upstream host/auth is resolved via BackendAdapter.streamEvents (issue
 * #42), not hardcoded to Managed Agents: production runs FORGE_BACKEND=gateway,
 * so task.sessionId is frequently a gateway session id, and asking Anthropic
 * for it 404s even though the gateway mirrors Anthropic's /v1/sessions/*
 * surface closely enough to make that bug invisible on a code read.
 * gemini-managed-agents has no equivalent endpoint at all — its adapter
 * throws AdapterNotImplementedError, which this route maps to the same
 * "unavailable" response as a missing session, below.
 *
 * It authenticates with getOptionalUser() + an explicit 401 rather than
 * withAuth(). withAuth() redirects, and this endpoint is opened by an
 * EventSource, which would follow the 302 and hand the client an HTML login
 * page as if it were an event stream — surfacing an expired session as an
 * opaque parse error. A 401 also stops EventSource retrying, which is right
 * here: reconnecting cannot fix a missing session, unlike the 503s below.
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
  const { missionId, taskId } = await params;

  const streamUnavailable = (status: number) =>
    new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const user = await getOptionalUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const task = await getTask(taskId, user.id);
  // The missionId in the path must actually own this task — otherwise the
  // nesting would be decorative, and /missions/<any>/tasks/<id>/stream would
  // serve a task the URL misdescribes.
  if (!task || task.missionId !== missionId || !task.sessionId) return streamUnavailable(503);

  // Ownership of task.missionId was already proven by getTask's join above —
  // see missionBackend's own doc comment for why this stays a plain,
  // unscoped lookup rather than a second (redundant, masking) ownership check.
  const backend = await missionBackend(task.missionId);
  if (!backend) return streamUnavailable(503);

  let upstream: Response;
  try {
    upstream = await getAdapter(backend).streamEvents(task.sessionId);
  } catch (err) {
    // No equivalent endpoint on this backend (gemini-managed-agents) — not a
    // transient upstream failure, so this isn't a 502.
    if (err instanceof AdapterNotImplementedError) return streamUnavailable(503);
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
