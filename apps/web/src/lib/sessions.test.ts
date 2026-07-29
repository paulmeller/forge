import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/sessions` is the mitigation for the part of the device flow that cannot be
 * fixed on the consent page: a human can be talked into approving an
 * attacker's user code, and no server-side check can tell that apart from a
 * legitimate approval. What can be guaranteed is that the resulting grant is
 * visible and can be ended.
 *
 * Two things are pinned here above all: that a session's TOKEN never leaves
 * the server, and that revocation resolves ids inside the caller's own session
 * list.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('./auth', () => ({
  auth: {
    api: {
      listSessions: mocks.listSessions,
      getSession: mocks.getSession,
      revokeSession: mocks.revokeSession,
    },
  },
}));

const { listActiveSessions, revokeSessionById } = await import('./sessions');

const REQUEST_HEADERS = new Headers({ cookie: 'better-auth.session_token=current' });

const BROWSER = {
  id: 'ses_browser',
  token: 'tok_browser_secret',
  createdAt: new Date('2026-07-01T10:00:00Z'),
  expiresAt: new Date('2026-08-01T10:00:00Z'),
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  userId: 'usr_alice',
};

const CLI = {
  id: 'ses_cli',
  token: 'tok_cli_secret',
  createdAt: new Date('2026-07-02T10:00:00Z'),
  expiresAt: new Date('2026-08-02T10:00:00Z'),
  ipAddress: '198.51.100.9',
  userAgent: 'forge-cli/1.0',
  userId: 'usr_alice',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers.mockResolvedValue(REQUEST_HEADERS);
  mocks.listSessions.mockResolvedValue([BROWSER, CLI]);
  mocks.getSession.mockResolvedValue({ session: { id: BROWSER.id }, user: { id: 'usr_alice' } });
  mocks.revokeSession.mockResolvedValue({ status: true });
});

describe('listActiveSessions', () => {
  it('never returns a session token', async () => {
    // The single most important assertion in this file. `session.token` is the
    // credential — the bearer plugin turns it straight back into a session,
    // and the auth route already strips it from a response header. Rendering
    // one into the page would hand every session's credential to any XSS.
    const sessions = await listActiveSessions();

    const serialised = JSON.stringify(sessions);
    expect(serialised).not.toContain(BROWSER.token);
    expect(serialised).not.toContain(CLI.token);
    for (const session of sessions) {
      expect(Object.keys(session)).not.toContain('token');
    }
  });

  it('asks better-auth for the caller’s sessions using the request headers', async () => {
    await listActiveSessions();

    expect(mocks.listSessions).toHaveBeenCalledWith({ headers: REQUEST_HEADERS });
  });

  it('marks the session making the request and no other', async () => {
    const sessions = await listActiveSessions();

    expect(sessions.filter((s) => s.current).map((s) => s.id)).toEqual([BROWSER.id]);
  });

  it('surfaces what distinguishes a device-issued session from a browser one', async () => {
    // A session created by /device/token records the polling CLI's IP and
    // user agent, not the approving browser's. That is the only signal a user
    // has, so it has to reach the page.
    const cli = (await listActiveSessions()).find((s) => s.id === CLI.id);

    expect(cli?.userAgent).toBe('forge-cli/1.0');
    expect(cli?.ipAddress).toBe('198.51.100.9');
  });

  it('orders newest first, so a session that just appeared is at the top', async () => {
    const sessions = await listActiveSessions();
    expect(sessions.map((s) => s.id)).toEqual([CLI.id, BROWSER.id]);
  });

  it('turns the empty strings better-auth writes into nulls', async () => {
    // better-auth stores '' rather than NULL when it has nothing to record,
    // and '' renders as a blank cell that reads like a bug.
    mocks.listSessions.mockResolvedValue([{ ...CLI, ipAddress: '', userAgent: '' }]);

    const [session] = await listActiveSessions();

    expect(session?.ipAddress).toBeNull();
    expect(session?.userAgent).toBeNull();
  });
});

describe('revokeSessionById', () => {
  it('revokes by the token it resolved server-side, never by anything from the form', async () => {
    const outcome = await revokeSessionById(CLI.id);

    expect(outcome).toEqual({ ok: true });
    expect(mocks.revokeSession).toHaveBeenCalledWith({
      headers: REQUEST_HEADERS,
      body: { token: CLI.token },
    });
  });

  it('refuses an id that is not in the caller’s own session list', async () => {
    // The list is scoped to the caller, so someone else's session id simply is
    // not in it. This is the resolution step doing its job — there is no
    // second userId comparison, deliberately, so that a break in better-auth's
    // own owner check could not be masked here.
    const outcome = await revokeSessionById('ses_someone_else');

    expect(outcome).toEqual({ ok: false, error: expect.any(String) });
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('refuses an empty id rather than revoking whatever is first', async () => {
    const outcome = await revokeSessionById('');

    expect(outcome.ok).toBe(false);
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('refuses to revoke the session making the request', async () => {
    // Signing yourself out has its own control; doing it from here leaves the
    // page re-rendering against a session that no longer exists.
    const outcome = await revokeSessionById(BROWSER.id);

    expect(outcome.ok).toBe(false);
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('still revokes other sessions when there is no current session to compare against', async () => {
    mocks.getSession.mockResolvedValue(null);

    const outcome = await revokeSessionById(CLI.id);

    expect(outcome).toEqual({ ok: true });
    expect(mocks.revokeSession).toHaveBeenCalledWith({
      headers: REQUEST_HEADERS,
      body: { token: CLI.token },
    });
  });
});
