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

  it('returns apiAuth\'s rejection without invoking the handler', async () => {
    const rejection = Response.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 });
    apiAuth.mockResolvedValue([null, rejection]);
    const spy = vi.fn();
    const handler = withApiAuth(async () => { spy(); return Response.json({}); });
    const res = await handler(new Request('http://x'), {});
    expect(res.status).toBe(401);
    // The gate must short-circuit — a handler that runs has already touched data.
    expect(spy).not.toHaveBeenCalled();
  });
});
