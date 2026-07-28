import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the API auth gate pattern.
 *
 * Since apiAuth() depends on next/headers and better-auth internals,
 * we test the contract: unauthenticated → 401, authenticated → user object.
 * The actual session verification is better-auth's responsibility.
 *
 * These tests mock the auth module to verify the gate logic.
 */

vi.mock('./auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// Dynamic import to ensure mocks are applied
const { apiAuth } = await import('./api-auth');
const { auth } = await import('./auth');
const { headers } = await import('next/headers');

describe('apiAuth', () => {
  it('returns 401 when no session exists', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const [user, response] = await apiAuth();
    expect(user).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);

    const body = await response!.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns user when session exists', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: { id: 'sess_1', token: 'tok', expiresAt: new Date(), userId: 'usr_1', createdAt: new Date(), updatedAt: new Date() },
      user: { id: 'usr_1', name: 'Alice', email: 'alice@example.com', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    } as never);

    const [user, response] = await apiAuth();
    expect(response).toBeNull();
    expect(user).not.toBeNull();
    expect(user!.id).toBe('usr_1');
    expect(user!.name).toBe('Alice');
    expect(user!.email).toBe('alice@example.com');
  });

  it('returns 401 when getSession throws', async () => {
    vi.mocked(auth.api.getSession).mockRejectedValue(new Error('db down'));

    const [user, response] = await apiAuth();
    expect(user).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it('returns 401 when session has no user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: { id: 'sess_1', token: 'tok', expiresAt: new Date(), userId: 'usr_1', createdAt: new Date(), updatedAt: new Date() },
      user: null,
    } as never);

    const [user, response] = await apiAuth();
    expect(user).toBeNull();
    expect(response!.status).toBe(401);
  });

  it('accepts a token presented as x-api-key by aliasing it to Authorization', async () => {
    // managed-agents (the sibling engine) accepts `x-api-key` first, else
    // `Authorization: Bearer`. Matching that pair lets one CLI speak to both.
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-api-key': 'tok_abc' }));
    vi.mocked(auth.api.getSession).mockImplementation((async (ctx: { headers: Headers }) => {
      return ctx.headers.get('authorization') === 'Bearer tok_abc'
        ? ({ user: { id: 'u1', name: 'A', email: 'a@x' } } as never)
        : null;
    }) as never);
    const [user] = await apiAuth();
    expect(user?.id).toBe('u1');
  });

  it('prefers an explicit Authorization header over x-api-key', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({
      authorization: 'Bearer real', 'x-api-key': 'ignored',
    }));
    vi.mocked(auth.api.getSession).mockImplementation((async (ctx: { headers: Headers }) => {
      return ctx.headers.get('authorization') === 'Bearer real'
        ? ({ user: { id: 'u2', name: 'B', email: 'b@x' } } as never)
        : null;
    }) as never);
    const [user] = await apiAuth();
    expect(user?.id).toBe('u2');
  });

  /**
   * One layer down, the bearer plugin APPENDS its synthesized cookie
   * (`existingCookie + '; ' + newCookie`) and better-call's parser keeps the
   * FIRST occurrence of a name — so a session cookie left attached silently
   * beats the presented token. A client with a cookie jar would then act as
   * the cookie's user while believing it acted as the token's: a wrong-user
   * action, not a failed one. These mocks reproduce that precedence, so they
   * only pass if apiAuth() removes the cookie when a token is presented.
   */
  const cookieWinsGetSession = (async (ctx: { headers: Headers }) => {
    const cookie = ctx.headers.get('cookie');
    if (cookie?.includes('cookie_user_token')) {
      return { user: { id: 'cookie_user', name: 'Cookie', email: 'cookie@x' } } as never;
    }
    const authz = ctx.headers.get('authorization');
    if (authz === 'Bearer token_user_token') {
      return { user: { id: 'token_user', name: 'Token', email: 'token@x' } } as never;
    }
    return null as never;
  }) as never;

  it('resolves to the bearer token user, not the cookie user, when both are present', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({
      cookie: 'better-auth.session_token=cookie_user_token',
      authorization: 'Bearer token_user_token',
    }));
    vi.mocked(auth.api.getSession).mockImplementation(cookieWinsGetSession);

    const [user] = await apiAuth();
    expect(user?.id).toBe('token_user');
  });

  it('resolves to the x-api-key user, not the cookie user, when both are present', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({
      cookie: 'better-auth.session_token=cookie_user_token',
      'x-api-key': 'token_user_token',
    }));
    vi.mocked(auth.api.getSession).mockImplementation(cookieWinsGetSession);

    const [user] = await apiAuth();
    expect(user?.id).toBe('token_user');
  });

  it('does not forward the cookie at all once a token is presented', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({
      cookie: 'better-auth.session_token=cookie_user_token',
      authorization: 'Bearer token_user_token',
    }));
    let seen: Headers | undefined;
    vi.mocked(auth.api.getSession).mockImplementation((async (ctx: { headers: Headers }) => {
      seen = ctx.headers;
      return { user: { id: 'token_user', name: 'Token', email: 'token@x' } } as never;
    }) as never);

    await apiAuth();
    expect(seen?.get('cookie')).toBeNull();
    expect(seen?.get('authorization')).toBe('Bearer token_user_token');
  });

  it('leaves the cookie alone when no token is presented', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({
      cookie: 'better-auth.session_token=cookie_user_token',
    }));
    vi.mocked(auth.api.getSession).mockImplementation(cookieWinsGetSession);

    const [user] = await apiAuth();
    expect(user?.id).toBe('cookie_user');
  });
});
