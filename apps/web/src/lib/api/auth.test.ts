import { describe, expect, it, vi } from 'vitest';

const apiAuth = vi.fn();
vi.mock('@/lib/api-auth', () => ({ apiAuth: () => apiAuth() }));

const { withApiAuth } = await import('./auth');

describe('withApiAuth', () => {
  it('passes the authenticated user to the handler', async () => {
    apiAuth.mockResolvedValue([{ id: 'u1', name: 'U', email: 'u@x' }, null]);
    const handler = withApiAuth(async (user) => Response.json({ id: user.id }));
    const res = await handler(new Request('http://x'), {});
    expect(await res.json()).toEqual({ id: 'u1' });
  });

  it('returns apiAuth\'s rejection verbatim without invoking the handler', async () => {
    // The body is a SENTINEL, deliberately not the real 401 envelope: apiAuth
    // is mocked here, so any assertion about the envelope's shape would only
    // re-assert this file's own fixture (which is exactly what the previous
    // version of this test did — it constructed `{ error: { code, message } }`,
    // a shape the real apiAuth did not then produce, and "verified" it). What
    // this wrapper is actually responsible for is passing the rejection
    // through untouched and not running the handler; the envelope itself is
    // pinned where it is produced, in lib/api-auth.test.ts.
    const rejection = Response.json({ sentinel: 'straight-from-apiAuth' }, { status: 401 });
    apiAuth.mockResolvedValue([null, rejection]);
    const spy = vi.fn();
    const handler = withApiAuth(async () => { spy(); return Response.json({}); });
    const res = await handler(new Request('http://x'), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ sentinel: 'straight-from-apiAuth' });
    // The gate must short-circuit — a handler that runs has already touched data.
    expect(spy).not.toHaveBeenCalled();
  });
});
