import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOctokit = vi.hoisted(() => ({
  repos: { getContent: vi.fn(), get: vi.fn(), createOrUpdateFileContents: vi.fn() },
  git: { getRef: vi.fn(), createRef: vi.fn() },
  pulls: { create: vi.fn(), list: vi.fn() },
}));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => mockOctokit) }));
// getOctokitClient() (lib/octokit.ts) throws unless GITHUB_APP_TOKEN is set,
// before it ever reaches the mocked Octokit constructor above — same idiom
// as auto-merge.test.ts.
vi.mock('@/lib/env', () => ({ env: { GITHUB_APP_TOKEN: 'ghp_test' } }));

const rows = vi.hoisted(() => ({
  repos: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/db', () => ({
  db: {
    // Two shapes share this mock: onboarding.ts's bare `.select().from(...)`
    // (select all repos, directly awaited) and repo-policy.ts's
    // `.select({ repoPolicy }).from(...).where(...).limit(1)` — resolveRepoPolicy
    // runs for real inside runOnboarding, unmocked. Distinguish by whether a
    // selection object was passed, same idiom as dispatcher.test.ts. None of
    // these tests exercise a stored database policy, so the scoped lookup
    // always resolves to "no row".
    select: (selection?: unknown) => ({
      from: () => (selection ? { where: () => ({ limit: async () => [] }) } : Promise.resolve(rows.repos)),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          rows.updates.push(v);
        },
      }),
    }),
  },
}));

import { runOnboarding } from './onboarding';

const noopLog = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  rows.repos = [];
  rows.updates = [];
  mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
  mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'base-sha' } } });
  mockOctokit.pulls.list.mockResolvedValue({ data: [] });
  mockOctokit.pulls.create.mockResolvedValue({ data: { html_url: 'https://github.com/acme/api/pull/5' } });
});

describe('runOnboarding', () => {
  it('opens a proposal PR for a pending repo with no file', async () => {
    rows.repos = [
      { id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'pending_onboarding', onboardingPrUrl: null },
    ];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.prsOpened).toBe(1);
    expect(mockOctokit.pulls.create).toHaveBeenCalledTimes(1);
    expect(rows.updates.some((u) => u.onboardingPrUrl === 'https://github.com/acme/api/pull/5')).toBe(true);
  });

  it('does not open a second PR when one is already recorded', async () => {
    // Opening a PR is not idempotent; a sweep that re-proposed every tick
    // would spam the operator's repo.
    rows.repos = [
      {
        id: 'r1',
        repo: 'acme/api',
        installationId: 'ghi_1',
        onboardingState: 'pending_onboarding',
        onboardingPrUrl: 'https://github.com/acme/api/pull/5',
      },
    ];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.prsOpened).toBe(0);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('activates a pending repo once the file is on the default branch', async () => {
    rows.repos = [
      { id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'pending_onboarding', onboardingPrUrl: 'https://x/pull/5' },
    ];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('gates:\n  ci: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.activated).toBe(1);
    expect(rows.updates.some((u) => u.onboardingState === 'active')).toBe(true);
  });

  it('does NOT activate on an invalid file', async () => {
    // Merging a file Forge cannot parse must not open the gate — the operator
    // would believe they had configured something Forge never read.
    rows.repos = [
      { id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'pending_onboarding', onboardingPrUrl: 'https://x/pull/5' },
    ];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('autoMerg:\n  enabled: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.activated).toBe(0);
    expect(rows.updates.some((u) => u.onboardingState === 'active')).toBe(false);
  });

  it('re-gates an active repo whose file was deleted', async () => {
    // Deleting the file that authorises autonomous work stops autonomous work.
    rows.repos = [{ id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'active', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.regated).toBe(1);
    expect(rows.updates.some((u) => u.onboardingState === 'pending_onboarding')).toBe(true);
  });

  it('leaves an active repo alone while its file is present', async () => {
    rows.repos = [{ id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'active', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('gates:\n  ci: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.regated).toBe(0);
    expect(rows.updates).toEqual([]);
  });

  it('does not re-gate an active repo whose file is present but invalid', async () => {
    // An invalid file already blocks dispatch through resolveRepoPolicy
    // ('invalid' never resolves to a usable policy, and claimNextBatch
    // never reaches an onboarding_state check for a repo whose policy call
    // errors first). Re-gating here as well would be a second, redundant
    // path to the same outcome — narrower is safer: only a genuine absence
    // (source 'default'/'database') re-gates.
    rows.repos = [{ id: 'r1', repo: 'acme/api', installationId: 'ghi_1', onboardingState: 'active', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('autoMerg:\n  enabled: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.regated).toBe(0);
    expect(rows.updates).toEqual([]);
  });
});
