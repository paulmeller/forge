import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

const handlers = toNextJsHandler(auth);

/**
 * The bearer plugin unconditionally echoes the raw session token in a
 * `set-auth-token` response header. We register bearer for its REQUEST side
 * only — `Authorization: Bearer` resolving to a session — and want nothing to
 * do with its response side. 1.6.9 exposes no option to disable it, so strip
 * it here.
 *
 * This addresses the header only. better-auth's core sign-in route also
 * returns `token: session.token` in the JSON response *body*, independent of
 * the bearer plugin — that credential still leaves the response. Stripping
 * the header is still worth doing: a header is CORS-exposed via
 * `Access-Control-Expose-Headers`, more likely to be proxy-logged, and
 * cache-adjacent in ways a body is not. It is a narrower fix than "the token
 * no longer leaves the response," not an equivalent one.
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
  // `new Response(body, { status })` throws for 204/205/304 when body is
  // non-null. Can't fire today — this branch only runs when set-auth-token
  // was present, which requires a session Set-Cookie, and those statuses
  // don't carry one — but guard it so a future upstream change can't turn
  // this into an uncaught TypeError.
  const nullBodyStatus = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(nullBodyStatus ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export const GET = async (req: Request) => stripAuthTokenHeader(await handlers.GET(req));
export const POST = async (req: Request) => stripAuthTokenHeader(await handlers.POST(req));
