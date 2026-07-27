import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Authorization decisions for the GitHub App install callback.
 *
 * The state cookie only exists for installs begun at /api/github/install.
 * GitHub calls this URL with no state for setup_on_update edits, the
 * Configure button, and installs started on the app's own GitHub page — so
 * "no cookie" must fall through to a real ownership check rather than reject.
 */

const cookieStore = new Map<string, string>();
const jar = {
  get: (k: string) => (cookieStore.has(k) ? { value: cookieStore.get(k)! } : undefined),
  delete: (k: string) => cookieStore.delete(k),
};
vi.mock('next/headers', () => ({ cookies: async () => jar }));

const user: { id: string; name: string; email: string } | null = {
  id: 'u1',
  name: 'User One',
  email: 'u1@forge.local',
};
vi.mock('@/lib/with-auth', () => ({ getOptionalUser: async () => user }));

const getAccessToken = vi.fn(async () => ({ accessToken: 'gho_tok' }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getAccessToken: () => getAccessToken() } } }));

const userHasInstallationAccess = vi.fn(async (_token: string, _installationId: number) => true);
vi.mock('@/lib/github-app-auth', () => ({
  userHasInstallationAccess: (t: string, id: number) => userHasInstallationAccess(t, id),
}));

const syncGithubInstallation = vi.fn(async () => {});
vi.mock('@/lib/github-installation-sync', () => ({
  syncGithubInstallation: () => syncGithubInstallation(),
}));

const insertValues = vi.fn(async () => {});
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({ values: insertValues }),
  },
}));

vi.mock('@forge/db', () => ({ githubInstallations: {} }));
vi.mock('@forge/db/orm', () => ({ eq: () => ({}) }));

const { GET } = await import('./route');
const { INSTALL_STATE_COOKIE } = await import('../install/route');

const call = (qs: string) => GET(new Request(`https://forge.example/api/github/callback${qs}`));

beforeEach(() => {
  cookieStore.clear();
  vi.clearAllMocks();
  userHasInstallationAccess.mockResolvedValue(true);
  getAccessToken.mockResolvedValue({ accessToken: 'gho_tok' });
});

describe('GitHub install callback authorization', () => {
  it('links a state-less callback when GitHub confirms the user has access', async () => {
    const res = await call('?installation_id=42');
    // The regression this guards: this used to redirect to an error, so
    // installing from GitHub's own app page never linked.
    expect(res.headers.get('location')).not.toContain('error=');
    expect(userHasInstallationAccess).toHaveBeenCalledWith('gho_tok', 42);
    expect(insertValues).toHaveBeenCalled();
  });

  it('rejects a state-less callback when GitHub says the user lacks access', async () => {
    userHasInstallationAccess.mockResolvedValue(false);
    const res = await call('?installation_id=999');
    expect(res.headers.get('location')).toContain('error=install_not_verified');
    // Sequential installation ids must not be claimable by guessing.
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('takes the cookie fast path without calling GitHub', async () => {
    cookieStore.set(INSTALL_STATE_COOKIE, 'abc123');
    const res = await call('?installation_id=42&state=abc123');
    expect(res.headers.get('location')).not.toContain('error=');
    expect(userHasInstallationAccess).not.toHaveBeenCalled();
  });

  it('consumes the state cookie so a replay cannot reuse it', async () => {
    cookieStore.set(INSTALL_STATE_COOKIE, 'abc123');
    await call('?installation_id=42&state=abc123');
    expect(cookieStore.has(INSTALL_STATE_COOKIE)).toBe(false);
  });

  it('falls back to the ownership check when the state is present but wrong', async () => {
    cookieStore.set(INSTALL_STATE_COOKIE, 'expected');
    userHasInstallationAccess.mockResolvedValue(false);
    const res = await call('?installation_id=42&state=forged');
    expect(res.headers.get('location')).toContain('error=install_not_verified');
  });

  it('rejects when no GitHub token can be obtained', async () => {
    getAccessToken.mockRejectedValue(new Error('no account'));
    const res = await call('?installation_id=42');
    expect(res.headers.get('location')).toContain('error=install_not_verified');
    expect(insertValues).not.toHaveBeenCalled();
  });
});
