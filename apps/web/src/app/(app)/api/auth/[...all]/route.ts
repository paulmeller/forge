import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

const handlers = toNextJsHandler(auth);

/**
 * The bearer plugin unconditionally echoes the raw session token in a
 * `set-auth-token` response header. We register bearer for its REQUEST side
 * only — `Authorization: Bearer` resolving to a session — and want nothing to
 * do with its response side, which duplicates an HttpOnly credential into a
 * plain header on every browser login. 1.6.9 exposes no option to disable it,
 * so strip it here.
 */
function stripAuthTokenHeader(res: Response): Response {
  if (!res.headers.has('set-auth-token')) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-auth-token');
  const exposed = headers.get('access-control-expose-headers');
  if (exposed) {
    const kept = exposed.split(',').map((h) => h.trim())
      .filter((h) => h && h.toLowerCase() !== 'set-auth-token');
    if (kept.length) headers.set('access-control-expose-headers', kept.join(', '));
    else headers.delete('access-control-expose-headers');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const GET = async (req: Request) => stripAuthTokenHeader(await handlers.GET(req));
export const POST = async (req: Request) => stripAuthTokenHeader(await handlers.POST(req));
