import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';
import { guardRateLimitEvasion } from '@/lib/auth-rate-limit';

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

/**
 * Two wrappers, in this order.
 *
 * `guardRateLimitEvasion` runs BEFORE the handler because the thing it is
 * closing happens inside better-auth's own `onRequest`: when `getIp` cannot
 * parse a client IP, `resolveRateLimitConfig` returns null and rate limiting
 * is skipped for the request entirely — not reduced, skipped — and that is one
 * caller-chosen `X-Forwarded-For` away behind Cloud Run, which appends to the
 * header rather than overwriting it. `customRules` are consulted after that
 * point, so no better-auth-level configuration can close it. See
 * lib/auth-rate-limit.ts for the full reasoning and for why the guard mirrors
 * `getIp` rather than inventing its own IP parsing.
 *
 * `stripAuthTokenHeader` runs after, on the response. Requests refused by the
 * guard never reach the handler, so they carry no `set-auth-token` to strip.
 */
export const GET = async (req: Request) =>
  guardRateLimitEvasion(req) ?? stripAuthTokenHeader(await handlers.GET(req));
export const POST = async (req: Request) =>
  guardRateLimitEvasion(req) ?? stripAuthTokenHeader(await handlers.POST(req));
