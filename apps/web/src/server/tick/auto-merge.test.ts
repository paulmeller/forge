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
    ledgerInserts: [] as Array<Record<string, unknown>>,
    env: { GITHUB_APP_TOKEN: 'ghp_test' as string | undefined },
  };

  const reset = () => {
    state.candidateRows = [];
    state.taskUpdateCalls = [];
    state.ledgerInserts = [];
    state.env.GITHUB_APP_TOKEN = 'ghp_test';
  };
  reset();

  const octokit = {
    pulls: { get: vi.fn(), merge: vi.fn(), listFiles: vi.fn() },
    repos: { getBranchProtection: vi.fn() },
    graphql: vi.fn(),
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
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        state.ledgerInserts.push(v);
        return undefined;
      }),
    })),
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
    approvedBy: null,
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

// --- Native auto-merge gating ---
//
// GitHub, not Forge, decides when the merge actually happens: we only arm
// native auto-merge (via the GraphQL `enablePullRequestAutoMerge` mutation)
// after confirming the branch has required checks that would gate it, and
// we never call `pulls.merge` ourselves any more.
const PR_URL = 'https://github.com/acme/repo/pull/7';
const PR_NODE_ID = 'PR_kwDOACME00007';

const mergeSpy = amMocks.octokit.pulls.merge;
const graphqlSpy = amMocks.octokit.graphql;
// The brief's test code drives this with a plain string[] ("no checks" /
// "['build']"); requiredChecksFor unwraps `data.required_status_checks.contexts`
// from the real Octokit response shape, so this spy sits underneath that
// unwrapping rather than replacing it.
const requiredChecksSpy = vi.fn<() => string[] | Promise<string[]>>();
amMocks.octokit.repos.getBranchProtection.mockImplementation(async () => ({
  data: { required_status_checks: { contexts: await requiredChecksSpy() } },
}));

let currentMission: Mission;

async function seedTask(overrides: Partial<Task> = {}): Promise<void> {
  amMocks.state.candidateRows.push({ task: amTask(overrides), mission: currentMission });
}

async function setPolicy(policy: Mission['autoMergePolicy']): Promise<void> {
  currentMission.autoMergePolicy = policy;
}

function lastBlockedReasons(): string[] {
  const blockedEvents = amMocks.state.ledgerInserts.filter(
    (e) => e.eventType === 'auto_merge.blocked',
  );
  const last = blockedEvents[blockedEvents.length - 1];
  const payload = last?.payload as { reasons?: string[] } | undefined;
  return payload?.reasons ?? [];
}

describe('tryMerge — native auto-merge gating (via runAutoMerge)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    amMocks.reset();
    currentMission = amMission();
    amMocks.octokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        title: 'Fix the thing',
        node_id: PR_NODE_ID,
        base: { ref: 'main' },
      },
    });
    requiredChecksSpy.mockReset();
    requiredChecksSpy.mockResolvedValue(['build']);
    graphqlSpy.mockReset();
    graphqlSpy.mockResolvedValue({});
  });

  // NOTE: "never selects a task that escalated to needs_human" is NOT
  // duplicated here. This file's mock `db.select().where(...)` returns
  // whatever `seedTask` pushes regardless of the real WHERE clause — a test
  // seeding a needs_human row here would pass or fail independent of
  // production's `eq(tasks.status, 'ready_to_merge')` filter, which is not a
  // real regression guard. That guarantee is proven for real against a live
  // SQLite DB in auto-merge.integration.test.ts instead.

  it('refuses to merge when the repo has no required checks configured', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
    requiredChecksSpy.mockResolvedValue([]);
    const res = await runAutoMerge(log);
    expect(res.merged).toBe(0);
    expect(res.blocked).toBe(1);
    expect(lastBlockedReasons()).toEqual(
      expect.arrayContaining([expect.stringContaining('no required checks')]),
    );
  });

  it('still treats a 404 from the branch-protection lookup as "unprotected" (known answer)', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
    amMocks.octokit.repos.getBranchProtection.mockRejectedValueOnce(
      Object.assign(new Error('Branch not protected'), { status: 404 }),
    );
    const res = await runAutoMerge(log);
    expect(res.merged).toBe(0);
    expect(res.blocked).toBe(1);
    expect(lastBlockedReasons()).toEqual(
      expect.arrayContaining([expect.stringContaining('no required checks')]),
    );
    // A 404 is a known, normal answer — must not be logged as a warning.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('blocks on an unknown branch-protection error (500) instead of claiming the branch is unprotected, and logs a warning', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
    amMocks.octokit.repos.getBranchProtection.mockRejectedValueOnce(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    );
    const res = await runAutoMerge(log);
    expect(res.merged).toBe(0);
    expect(res.blocked).toBe(1);
    const reasons = lastBlockedReasons();
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('unknown')]),
    );
    // Must NOT report the branch as unprotected when the real answer is unknown.
    expect(reasons.some((r) => r.includes('no required checks configured'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('Internal Server Error') }),
      'auto-merge:required_checks_unknown',
    );
  });

  it('blocks when the policy names a check the repo does not require', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
    requiredChecksSpy.mockResolvedValue(['build']);
    await setPolicy({ enabled: true, requiredChecks: ['build', 'e2e'] });
    const res = await runAutoMerge(log);
    expect(res.blocked).toBe(1);
    expect(lastBlockedReasons()).toEqual(
      expect.arrayContaining([expect.stringContaining('e2e')]),
    );
  });

  it('enables native auto-merge instead of merging directly', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
    requiredChecksSpy.mockResolvedValue(['build']);
    await runAutoMerge(log);
    // GitHub owns the merge decision; we must not call pulls.merge ourselves.
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).toHaveBeenCalledWith(
      expect.stringContaining('enablePullRequestAutoMerge'),
      expect.objectContaining({ pullRequestId: PR_NODE_ID }),
    );
  });

  it('skips unapproved tasks when the policy requires human approval', async () => {
    await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL, approvedBy: null });
    await setPolicy({ enabled: true, requireHumanApproval: true });
    const res = await runAutoMerge(log);
    expect(res.merged).toBe(0);
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  it('rolls back to needs_human with escalationReason auto_merge_failed when the GitHub merge call fails', async () => {
    graphqlSpy.mockRejectedValue(new Error('Pull Request is not mergeable'));
    // approvedBy set — this task reached ready_to_merge via a prior human
    // Approve — so the assertion below actually exercises the clearing
    // rather than passing vacuously on an already-null field.
    amMocks.state.candidateRows = [{ task: amTask({ approvedBy: 'u1' }), mission: amMission() }];

    const result = await runAutoMerge(log);

    expect(result.blocked).toBe(1);
    expect(result.merged).toBe(0);
    const rollbackCall = amMocks.state.taskUpdateCalls.find((call) => call.status === 'needs_human');
    expect(rollbackCall?.status).toBe('needs_human');
    expect(rollbackCall?.escalationReason).toBe('auto_merge_failed');
    expect(rollbackCall?.lastError).toContain('Pull Request is not mergeable');
    // The task that just bounced off a failed merge attempt is re-escalated
    // to a human — any earlier approval covered a merge that never happened
    // and must not survive to authorize whatever comes out of this rollback.
    expect(rollbackCall?.approvedBy).toBeNull();
  });
});
