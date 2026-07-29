import { z } from 'zod';

/**
 * One request header currently disables every rate limit on the better-auth
 * router. This file is the in-process patch for that, and the reasoning has to
 * live somewhere it will be read before someone "simplifies" it.
 *
 * ── The hole ──────────────────────────────────────────────────────────────
 *
 * better-auth keys its limiter on `getIp`
 * (better-auth/dist/utils/get-request-ip.mjs). For each header in
 * `advanced.ipAddress.ipAddressHeaders` it takes `value.split(',')[0].trim()`
 * and, if that string is not a valid IP, moves on. If nothing parses it
 * returns null (outside dev/test, where it substitutes 127.0.0.1).
 *
 * `resolveRateLimitConfig` treats a null IP as "cannot key the limiter" and
 * returns null. `onRequestRateLimit` then returns undefined — **no limiting at
 * all**, for every route on the router. Not a smaller limit; none.
 *
 * Cloud Run — the deploy target, see .github/workflows/deploy.yml — *appends*
 * to `X-Forwarded-For` rather than overwriting it. So a client that sends
 * `X-Forwarded-For: x` is received as `x, <real client ip>`: first element
 * `x`, invalid, null IP, limiting skipped. That is one header, chosen by the
 * caller, against the unauthenticated row-creating `/device/code` and against
 * the default 3-requests-per-10s rule on `/sign-in/*`.
 *
 * ── Why the fix is here and not in better-auth config ─────────────────────
 *
 * The skip happens inside the router's `onRequest`, *before* `customRules` are
 * consulted, so no rule — however tight — can close it. The route boundary
 * (app/(app)/api/auth/[...all]/route.ts) is the first place in our own code
 * that sees the request, so that is where it is closed.
 *
 * ── What the fix is ───────────────────────────────────────────────────────
 *
 * Fail closed: a request whose client IP better-auth could not resolve is
 * treated as rate-limited rather than unlimited, and answered 429 without
 * reaching the router. `resolveRateLimitIp` below is a deliberate mirror of
 * `getIp` — same header list, same `split(',')[0]`, the same zod IP validators
 * better-auth's `isValidIP` uses, and the same dev/test loopback substitution —
 * because the guard is only correct if it says "unresolvable" in exactly the
 * cases where better-auth would have skipped. Being *stricter* than `getIp` is
 * safe (we refuse a request better-auth would have limited); being *looser* is
 * the bug back again, so the mirror is the point.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * It does not make the limiter's key trustworthy. Behind Cloud Run with no
 * load balancer the first element of `X-Forwarded-For` is still caller-chosen,
 * so an attacker can still rotate it to get a fresh bucket per request. This
 * only removes the strictly better option of turning the limiter off entirely.
 * The real fix is infrastructure that *overwrites* `X-Forwarded-For` with the
 * observed peer address — documented in docs/operator-setup.md.
 */

/**
 * The headers better-auth reads the client IP from, and the single source of
 * truth for it: lib/auth.ts passes this same array to
 * `advanced.ipAddress.ipAddressHeaders`. If the two drifted, this guard would
 * be checking a header the limiter does not key on, which is worse than not
 * having it.
 */
export const AUTH_IP_ADDRESS_HEADERS = ['x-forwarded-for'] as const;

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

/**
 * better-auth's `isValidIP`, reproduced from
 * @better-auth/core/dist/utils/ip.mjs, which is exactly
 * `z.ipv4().safeParse(ip).success || z.ipv6().safeParse(ip).success`.
 *
 * zod is already a direct dependency of this app, so this is the same
 * implementation rather than an approximation of it — no new dependency, and
 * no hand-rolled IP regex that could accept something `getIp` rejects.
 */
export function isValidClientIp(ip: string): boolean {
  return ipv4.safeParse(ip).success || ipv6.safeParse(ip).success;
}

type ResolveOptions = {
  ipAddressHeaders?: readonly string[];
  /** Injected in tests. Defaults to the ambient NODE_ENV. */
  nodeEnv?: string;
  /** Injected in tests. Defaults to the ambient TEST. better-auth honours it. */
  testEnv?: string;
};

/**
 * The client IP better-auth's limiter would key on, or null if it would give
 * up and skip limiting.
 *
 * The dev/test loopback substitution is copied from `getIp` rather than
 * dropped: without it every local `next dev` request and every test would look
 * unresolvable (a browser on localhost sends no `X-Forwarded-For`) and the
 * guard would 429 the whole auth surface in development. It is not a bypass —
 * better-auth applies the same substitution, so in those environments the
 * limiter is not being skipped either.
 *
 * This is a mirror of better-auth's PRIVATE `getIp`
 * (better-auth/dist/utils/get-request-ip.mjs), not a call into it — there is
 * no public export to call. A mirror only stays correct for as long as it
 * stays identical to what it mirrors, so re-diff this function against
 * `getIp` on every better-auth version bump. One gap `getIp` has that this
 * function does not mirror: it opens with
 * `if (options.advanced?.ipAddress?.disableIpTracking) return null`, which
 * would make better-auth skip its limiter for every request while this
 * function kept resolving IPs and `guardRateLimitEvasion` kept waving them
 * through. `disableIpTracking` staying unset is pinned by a test in
 * auth.test.ts (alongside the `AUTH_IP_ADDRESS_HEADERS` assertion) rather
 * than mirrored here, because there is nothing for this function to *do*
 * with that option — the failure mode is better-auth's config drifting, not
 * this function's logic.
 */
export function resolveRateLimitIp(headers: Headers, options: ResolveOptions = {}): string | null {
  const ipHeaders = options.ipAddressHeaders ?? AUTH_IP_ADDRESS_HEADERS;

  for (const key of ipHeaders) {
    const value = headers.get(key);
    if (typeof value !== 'string') continue;
    // `split(',')[0]` — the same choice better-auth makes, and the same reason
    // this guard is needed: behind an appending proxy the caller owns that
    // element.
    // `String.split` always yields at least one element, so the default never
    // fires at runtime; it is here because noUncheckedIndexedAccess is on.
    const [first = ''] = value.split(',');
    const candidate = first.trim();
    if (isValidClientIp(candidate)) return candidate;
  }

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? '';
  const testEnv = options.testEnv ?? process.env.TEST;
  const isTest = nodeEnv === 'test' || testEnv === 'true' || testEnv === '1';
  const isDevelopment = nodeEnv === 'dev' || nodeEnv === 'development';
  if (isTest || isDevelopment) return '127.0.0.1';

  return null;
}

/**
 * The 429 an unresolvable client IP earns.
 *
 * Byte-identical in shape to `rateLimitResponse` in
 * better-auth/dist/api/rate-limiter/index.mjs — same status, same statusText,
 * same JSON body, same `X-Retry-After` header — so a CLI or browser that
 * already handles better-auth's 429 needs no second case. The retry hint is
 * the longest window we configure; there is no per-key state behind this
 * refusal to compute a real remaining time from, and overstating it is the
 * safe direction.
 */
export const UNRESOLVABLE_IP_RETRY_AFTER_SECONDS = 60;

export function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ message: 'Too many requests. Please try again later.' }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: {
      'content-type': 'application/json',
      'X-Retry-After': String(UNRESOLVABLE_IP_RETRY_AFTER_SECONDS),
    },
  });
}

/**
 * The guard the auth route applies to every request before handing it to
 * better-auth. Returns the refusal, or null to continue.
 *
 * It covers the whole router rather than `/device/code` alone. `/device/code`
 * is the sharpest case — unauthenticated and row-creating — but the same one
 * header disables the default 3-per-10s rule on `/sign-in/*`, which is a
 * password-guessing budget, and every other rule besides. Narrowing this to
 * one path would leave the credential-stuffing surface open for no gain: the
 * only requests it refuses are ones carrying a syntactically invalid
 * `X-Forwarded-For` first element, which no browser and no ordinary proxy
 * produces.
 */
export function guardRateLimitEvasion(req: Request): Response | null {
  return resolveRateLimitIp(req.headers) === null ? rateLimitedResponse() : null;
}
