import { beforeEach, describe, expect, it, vi } from 'vitest';

// Covers the NEW `resolveRepoPolicy` (the whole-policy reader added for #40 —
// file -> database -> defaults). This is a separate test file from
// repo-policy.test.ts on purpose: that suite exercises `getRepoPolicy` /
// `getRepoPolicyForUser` against a real migrated libSQL file and must not be
// touched, while this function needs GitHub mocked instead.
const mockOctokit = vi.hoisted(() => ({ repos: { getContent: vi.fn() } }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => mockOctokit) }));
// getOctokitClient() (lib/octokit.ts) throws unless GITHUB_APP_TOKEN is set,
// before it ever reaches the mocked Octokit constructor above.
vi.mock('./env', () => ({ env: { GITHUB_APP_TOKEN: 'ghp_test' } }));

const mockDb = vi.hoisted(() => ({ rows: [] as Array<{ repoPolicy: unknown }> }));
vi.mock('./db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => mockDb.rows }) }),
    }),
  },
}));

import { clearRepoPolicyCache, resolveRepoPolicy } from './repo-policy';

function fileContent(body: string) {
  return { data: { content: Buffer.from(body).toString('base64'), encoding: 'base64' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoPolicyCache();
  mockDb.rows = [];
});

describe('resolveRepoPolicy', () => {
  it('uses the file when present', async () => {
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('autoMerge:\n  enabled: true\n'));
    const res = await resolveRepoPolicy('acme/api', 'ghi_1');
    expect(res).toMatchObject({ source: 'file' });
    if (res.source !== 'file') return;
    expect(res.policy.autoMerge.enabled).toBe(true);
  });

  it('takes the WHOLE policy from the file, never merging database values', async () => {
    // The spec's central rule. A field-by-field merge would put the effective
    // policy in neither place and let the two disagree silently.
    mockDb.rows = [{ repoPolicy: { requirePlanApproval: true } }];
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('requirePlanApproval: false\n'));
    const res = await resolveRepoPolicy('acme/api', 'ghi_1');
    if (res.source !== 'file') throw new Error('expected file');
    expect(res.policy.requirePlanApproval).toBe(false);
  });

  it('falls back to the database when the file is absent (404)', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    mockDb.rows = [{ repoPolicy: { requirePlanApproval: true } }];
    const res = await resolveRepoPolicy('acme/api', 'ghi_1');
    expect(res).toMatchObject({ source: 'database' });
    if (res.source !== 'database') return;
    expect(res.policy.requirePlanApproval).toBe(true);
  });

  it('falls back to defaults when neither file nor database row exists', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    const res = await resolveRepoPolicy('acme/api', 'ghi_1');
    expect(res).toMatchObject({ source: 'default' });
  });

  it('skips the database fallback without an installation id, rather than reading unscoped', async () => {
    // A repo string is not unique across tenants (github_installation_repos'
    // unique index is (installationId, repo) — see repo-policy.ts's existing
    // getRepoPolicy doc comment). Without an installation id to scope by,
    // reading the database would risk answering with a different tenant's
    // row for the same repo name, so this must fall to defaults instead.
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    mockDb.rows = [{ repoPolicy: { requirePlanApproval: true } }];
    const res = await resolveRepoPolicy('acme/api', null);
    expect(res).toMatchObject({ source: 'default' });
  });

  it('reports an invalid file rather than falling back', async () => {
    // Falling back here would enable defaults the operator believed they had
    // overridden — the failure mode a typo must never produce.
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('autoMerg:\n  enabled: true\n'));
    const res = await resolveRepoPolicy('acme/api', 'ghi_1');
    expect(res.source).toBe('invalid');
    if (res.source !== 'invalid') return;
    expect(res.error).toMatch(/autoMerg/);
  });

  it('propagates a non-404 GitHub failure — "could not tell" is not "absent"', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(resolveRepoPolicy('acme/api', 'ghi_1')).rejects.toThrow('boom');
  });

  it('caches within a tick', async () => {
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('gates:\n  ci: true\n'));
    await resolveRepoPolicy('acme/api', 'ghi_1');
    await resolveRepoPolicy('acme/api', 'ghi_1');
    expect(mockOctokit.repos.getContent).toHaveBeenCalledTimes(1);
  });
});
