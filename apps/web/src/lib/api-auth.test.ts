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
});
