import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bearer plugin's after-hook matcher is literally `return true`, so on
 * every response that sets a session cookie — email sign-in, sign-up, the
 * GitHub OAuth callback — it copies the raw session token into a
 * `set-auth-token` response header and advertises it via
 * `Access-Control-Expose-Headers`. That turns an HttpOnly-cookie-only
 * credential into an ordinary header value that logs, proxies and caches will
 * handle. 1.6.9 exposes no option to disable it, so the route strips it at the
 * boundary. These tests pin that stripping.
 */

const upstream = vi.hoisted(() => ({
  GET: vi.fn<(req: Request) => Promise<Response>>(),
  POST: vi.fn<(req: Request) => Promise<Response>>(),
}));

vi.mock('@/lib/auth', () => ({ auth: {} }));
vi.mock('better-auth/next-js', () => ({
  toNextJsHandler: () => ({ GET: upstream.GET, POST: upstream.POST }),
}));

const { GET, POST } = await import('./route');

const req = () => new Request('https://forge.test/api/auth/sign-in/email', { method: 'POST' });

describe('auth catch-all route', () => {
  it('strips set-auth-token and its expose-headers entry from the response', async () => {
    upstream.POST.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        statusText: 'OK',
        headers: {
          'set-auth-token': 'raw_session_token_value',
          'access-control-expose-headers': 'set-auth-token',
          'content-type': 'application/json',
          'set-cookie': 'better-auth.session_token=raw_session_token_value; HttpOnly',
        },
      }),
    );

    const res = await POST(req());

    expect(res.headers.get('set-auth-token')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBeNull();
    // Everything else survives, including the HttpOnly cookie that is the
    // credential's legitimate carrier.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('keeps other exposed headers while removing only set-auth-token', async () => {
    upstream.POST.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'set-auth-token': 'raw_session_token_value',
          'access-control-expose-headers': 'x-trace-id, Set-Auth-Token, x-request-id',
        },
      }),
    );

    const res = await POST(req());

    expect(res.headers.get('set-auth-token')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBe('x-trace-id, x-request-id');
  });

  it('does not leak the token value anywhere in the response headers', async () => {
    upstream.POST.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'set-auth-token': 'raw_session_token_value',
          'access-control-expose-headers': 'set-auth-token',
        },
      }),
    );

    const res = await POST(req());

    const serialised = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    expect(serialised).not.toContain('raw_session_token_value');
    expect(serialised.toLowerCase()).not.toContain('set-auth-token');
  });

  it('passes a response without set-auth-token through untouched', async () => {
    const original = new Response('{"session":null}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    upstream.GET.mockResolvedValue(original);

    const res = await GET(new Request('https://forge.test/api/auth/get-session'));

    expect(res).toBe(original);
  });

  it('strips the header on GET responses too', async () => {
    upstream.GET.mockResolvedValue(
      new Response(null, { status: 302, headers: { 'set-auth-token': 'oauth_callback_token' } }),
    );

    const res = await GET(new Request('https://forge.test/api/auth/callback/github'));

    expect(res.headers.get('set-auth-token')).toBeNull();
    expect(res.status).toBe(302);
  });

  /**
   * better-auth emits more than one Set-Cookie on real paths — the session
   * cookie plus `dont_remember` or OAuth state clearing. `new Headers(res)`
   * preserves each as a distinct entry; `Object.fromEntries(res.headers)`
   * would collapse them to the last one and still pass every other assertion
   * in this file, since they all use a single cookie. Pin the multi-cookie
   * case explicitly.
   */
  it('preserves multiple distinct Set-Cookie entries through the reconstruction', async () => {
    const raw = new Response('{"ok":true}', {
      status: 200,
      headers: { 'set-auth-token': 'raw_session_token_value' },
    });
    raw.headers.append('set-cookie', 'better-auth.session_token=raw_session_token_value; HttpOnly');
    raw.headers.append('set-cookie', 'dont_remember=1; Path=/');
    upstream.POST.mockResolvedValue(raw);

    const res = await POST(req());

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies).toContain('better-auth.session_token=raw_session_token_value; HttpOnly');
    expect(cookies).toContain('dont_remember=1; Path=/');
  });
});

/**
 * The other half of what this route wraps.
 *
 * better-auth's limiter keys on `getIp`. When `getIp` cannot parse a client IP
 * it returns null, `resolveRateLimitConfig` returns null, and
 * `onRequestRateLimit` does nothing — rate limiting is skipped for that
 * request across the whole router, `/device/code` and `/sign-in/*` included.
 * Cloud Run APPENDS to `X-Forwarded-For`, so a caller sending
 * `X-Forwarded-For: x` is received as `x, <real ip>` and the first element is
 * invalid. That skip happens inside `onRequest`, before `customRules` are
 * consulted, so it cannot be closed from the better-auth config; the route is
 * the first place our own code sees the request.
 *
 * These tests assert the request never reaches the handler — a 429 that still
 * ran the endpoint would, for `/device/code`, still have created the row.
 */
describe('auth catch-all route — unresolvable client IP is refused, not served unlimited', () => {
  // vitest sets NODE_ENV=test AND TEST=true, and better-auth's `isTest()`
  // honours either, so both have to go for the production reading.
  const inProduction = () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEST', '');
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const spoofed = (path: string) =>
    new Request(`https://forge.test/api/auth${path}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': 'x, 203.0.113.7' },
    });

  it('answers 429 for /device/code and never calls the handler', async () => {
    inProduction();
    upstream.POST.mockResolvedValue(new Response('{"device_code":"leaked"}', { status: 200 }));

    const res = await POST(spoofed('/device/code'));

    expect(res.status).toBe(429);
    expect(upstream.POST).not.toHaveBeenCalled();
  });

  it('answers 429 for /sign-in/email too', async () => {
    inProduction();
    upstream.POST.mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await POST(spoofed('/sign-in/email'));

    expect(res.status).toBe(429);
    expect(upstream.POST).not.toHaveBeenCalled();
  });

  it('guards GET as well as POST', async () => {
    inProduction();
    upstream.GET.mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await GET(
      new Request('https://forge.test/api/auth/get-session', {
        headers: { 'x-forwarded-for': 'x, 203.0.113.7' },
      }),
    );

    expect(res.status).toBe(429);
    expect(upstream.GET).not.toHaveBeenCalled();
  });

  it('serves a request whose client IP resolves', async () => {
    inProduction();
    upstream.POST.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await POST(
      new Request('https://forge.test/api/auth/device/code', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      }),
    );

    expect(res.status).toBe(200);
    expect(upstream.POST).toHaveBeenCalledOnce();
  });

  it('does not refuse ordinary local requests, where getIp substitutes loopback', async () => {
    // NODE_ENV is 'test' here — deliberately not stubbed. If the guard fired
    // in dev/test it would 429 every sign-in on a developer machine, which is
    // the failure mode that would get it deleted rather than fixed.
    upstream.POST.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await POST(new Request('https://forge.test/api/auth/sign-in/email', { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(upstream.POST).toHaveBeenCalledOnce();
  });
});
