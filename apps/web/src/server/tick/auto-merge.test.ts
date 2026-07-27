import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mission, Task } from '@forge/db';

import { evaluatePolicy, _globMatch, runAutoMerge } from './auto-merge';

describe('evaluatePolicy', () => {
  const noFiles = { files: null };

  it('passes a small diff inside all caps', () => {
    expect(
      evaluatePolicy(
        { additions: 5, deletions: 3, filesChanged: 1, ...noFiles },
        { enabled: true, maxAdditions: 20, maxDeletions: 20, maxFilesChanged: 5 },
      ),
    ).toEqual([]);
  });

  it('blocks when additions exceed cap', () => {
    const reasons = evaluatePolicy(
      { additions: 50, deletions: 0, filesChanged: 1, ...noFiles },
      { enabled: true, maxAdditions: 20 },
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/additions 50.*maxAdditions 20/);
  });

  it('blocks when deletions exceed cap', () => {
    const reasons = evaluatePolicy(
      { additions: 0, deletions: 100, filesChanged: 1, ...noFiles },
      { enabled: true, maxDeletions: 50 },
    );
    expect(reasons[0]).toMatch(/deletions 100.*maxDeletions 50/);
  });

  it('blocks when filesChanged exceeds cap', () => {
    const reasons = evaluatePolicy(
      { additions: 1, deletions: 1, filesChanged: 12, ...noFiles },
      { enabled: true, maxFilesChanged: 3 },
    );
    expect(reasons[0]).toMatch(/filesChanged 12.*maxFilesChanged 3/);
  });

  it('aggregates multiple violations', () => {
    const reasons = evaluatePolicy(
      { additions: 100, deletions: 100, filesChanged: 100, ...noFiles },
      { enabled: true, maxAdditions: 10, maxDeletions: 10, maxFilesChanged: 1 },
    );
    expect(reasons).toHaveLength(3);
  });

  it('treats undefined caps as no constraint', () => {
    expect(
      evaluatePolicy({ additions: 999, deletions: 999, filesChanged: 99, ...noFiles }, { enabled: true }),
    ).toEqual([]);
  });
});

describe('globMatch', () => {
  it('matches exact paths', () => {
    expect(_globMatch('package.json', 'package.json')).toBe(true);
    expect(_globMatch('src/foo.ts', 'package.json')).toBe(false);
  });

  it('* does not cross directory boundaries', () => {
    expect(_globMatch('foo.ts', '*.ts')).toBe(true);
    expect(_globMatch('src/foo.ts', '*.ts')).toBe(false);
  });

  it('** crosses directory boundaries', () => {
    expect(_globMatch('src/foo.ts', '**/*.ts')).toBe(true);
    expect(_globMatch('src/nested/deep/foo.ts', '**/*.ts')).toBe(true);
  });

  it('escapes regex meta characters', () => {
    expect(_globMatch('package.json', 'package.json')).toBe(true);
    expect(_globMatch('packageXjson', 'package.json')).toBe(false);
  });

  it('matches lockfile-only policy', () => {
    const allowlist = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    expect(allowlist.some((p) => _globMatch('package-lock.json', p))).toBe(true);
    expect(allowlist.some((p) => _globMatch('src/foo.ts', p))).toBe(false);
  });
});

// --- tryMerge's rollback branch (private, exercised through the exported
// runAutoMerge) ---
//
// `tryMerge` isn't exported, so we drive it end-to-end via `runAutoMerge`:
// seed one `ready_to_merge` Task whose Mission has an auto-merge policy that
// permits the diff shape, make the (mocked) GitHub merge call fail, and
// assert on the payload `db.update` receives — this guards the
// status/escalationReason mapping the rollback path writes, which a
// reviewer verified by reading source but nothing encoded until now.
const amMocks = vi.hoisted(() => {
  const state = {
    candidateRows: [] as Array<{ task: Task; mission: Mission }>,
    taskUpdateCalls: [] as Array<Record<string, unknown>>,
    env: { GITHUB_APP_TOKEN: 'ghp_test' as string | undefined },
  };

  const reset = () => {
    state.candidateRows = [];
    state.taskUpdateCalls = [];
    state.env.GITHUB_APP_TOKEN = 'ghp_test';
  };
  reset();

  const octokit = {
    pulls: { get: vi.fn(), merge: vi.fn(), listFiles: vi.fn() },
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(async () => state.candidateRows),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.taskUpdateCalls.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return { db, octokit, reset, state };
});

vi.mock('@/lib/db', () => ({ db: amMocks.db }));
vi.mock('@/lib/env', () => ({ env: amMocks.state.env }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => amMocks.octokit) }));

function amTask(overrides: Partial<Task> = {}): Task {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'tsk_1',
    missionId: 'mis_1',
    repo: 'acme/repo',
    baseBranch: 'main',
    promptVars: null,
    issueRef: null,
    kind: 'standard',
    verdict: null,
    dependsOnIds: null,
    status: 'ready_to_merge',
    sessionId: null,
    backendSessionRef: null,
    prUrl: 'https://github.com/acme/repo/pull/7',
    prNumber: 7,
    diffAdditions: null,
    diffDeletions: null,
    filesChanged: null,
    retryCount: 0,
    aiReviewRetryCount: 0,
    turnCount: 0,
    lastProgressAt: null,
    costTokensAtProgress: 0,
    verifyRetryCount: 0,
    lastVerifiedSha: null,
    haltReason: null,
    escalationReason: null,
    reviewDecision: null,
    acceptanceCriteria: null,
    lastError: null,
    costUsd: 0,
    costTokens: 0,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: now,
    completedAt: null,
    ...overrides,
  } as Task;
}

function amMission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'mis_1',
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'triage',
    targetRepos: null,
    issueQuery: null,
    workspaceRepo: null,
    issueRef: null,
    parentMissionId: null,
    nextIssueRefs: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    spentUsd: 0,
    spentTokens: 0,
    autoMergePolicy: { enabled: true },
    webhookSecret: 'secret',
    githubInstallationId: null,
    githubVaultId: null,
    skillId: null,
    aiReviewEnabled: false,
    budgetHardStopPct: 100,
    taskMaxTokens: null,
    taskMaxTurns: null,
    noProgressTokens: null,
    selfVerifyEnabled: false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as Mission;
}

describe('tryMerge rollback path (via runAutoMerge)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    amMocks.reset();
    amMocks.octokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        title: 'Fix the thing',
      },
    });
    amMocks.octokit.pulls.merge.mockRejectedValue(new Error('Pull Request is not mergeable'));
  });

  it('rolls back to needs_human with escalationReason auto_merge_failed when the GitHub merge call fails', async () => {
    amMocks.state.candidateRows = [{ task: amTask(), mission: amMission() }];

    const result = await runAutoMerge(log);

    expect(result.blocked).toBe(1);
    expect(result.merged).toBe(0);
    const rollbackCall = amMocks.state.taskUpdateCalls.find((call) => call.status === 'needs_human');
    expect(rollbackCall?.status).toBe('needs_human');
    expect(rollbackCall?.escalationReason).toBe('auto_merge_failed');
    expect(rollbackCall?.lastError).toContain('Pull Request is not mergeable');
  });
});
