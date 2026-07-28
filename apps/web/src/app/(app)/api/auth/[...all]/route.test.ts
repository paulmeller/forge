import { describe, expect, it, vi } from 'vitest';

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
});
