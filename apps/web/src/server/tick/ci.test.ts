import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@forge/db';

import { buildRetryPrompt, runCiPoller, type FailedCheck } from './ci';

describe('buildRetryPrompt', () => {
  const sha = 'abc123def456';

  it('includes the SHA in the prompt', () => {
    const prompt = buildRetryPrompt(sha, []);
    expect(prompt).toContain(sha);
  });

  it('lists a single failed check with name and conclusion', () => {
    const checks: FailedCheck[] = [
      { name: 'lint', conclusion: 'failure' },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('- lint (failure)');
  });

  it('includes output title and summary when present', () => {
    const checks: FailedCheck[] = [
      {
        name: 'test-suite',
        conclusion: 'failure',
        output: { title: 'Tests Failed', summary: '3 of 42 tests failed' },
      },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('test-suite (failure): Tests Failed — 3 of 42 tests failed');
  });

  it('includes the details URL when present', () => {
    const checks: FailedCheck[] = [
      {
        name: 'build',
        conclusion: 'timed_out',
        detailsUrl: 'https://github.com/acme/api/actions/runs/123',
      },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('[https://github.com/acme/api/actions/runs/123]');
  });

  it('handles multiple failed checks', () => {
    const checks: FailedCheck[] = [
      { name: 'lint', conclusion: 'failure' },
      { name: 'test', conclusion: 'failure' },
      { name: 'deploy', conclusion: 'cancelled' },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('- lint (failure)');
    expect(prompt).toContain('- test (failure)');
    expect(prompt).toContain('- deploy (cancelled)');
  });

  it('omits output fields when null', () => {
    const checks: FailedCheck[] = [
      { name: 'build', conclusion: 'failure', output: { title: null, summary: null } },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    // Should just have "build (failure)" without trailing ": "
    expect(prompt).toContain('- build (failure)');
    expect(prompt).not.toContain('- build (failure):');
  });

  it('includes instructions to fix and push', () => {
    const prompt = buildRetryPrompt(sha, [{ name: 'ci', conclusion: 'failure' }]);
    expect(prompt).toContain('fix the issue');
    expect(prompt).toContain('push the fix');
  });
});

// --- retryWithFeedback (private, exercised through the exported runCiPoller) ---
//
// `retryWithFeedback` isn't exported, so we drive it end-to-end via
// `runCiPoller`: seed one `awaiting_ci` task with a failing check run, and
// assert on the payload the mocked `db.update` receives — this is what
// guards against a typo like writing `task.sessionId` instead of
// `result.backendSessionRef`, or dropping the field entirely.
const ciMocks = vi.hoisted(() => {
  const state = {
    awaitingTasks: [] as Task[],
    missionRow: undefined as { backend: string } | undefined,
    taskUpdateCalls: [] as Array<Partial<Task>>,
    // Rows the ci.retry_dispatched ledger lookup returns; empty = never retried.
    retryDispatchRows: [] as Array<{ payload: unknown; createdAt: Date }>,
    env: {
      GITHUB_APP_TOKEN: 'ghp_test' as string | undefined,
      TASK_RETRY_MAX: 3,
      RETRY_STALL_MS: 600_000,
    },
  };

  const reset = () => {
    state.awaitingTasks = [];
    state.missionRow = { backend: 'managed-agents' };
    state.taskUpdateCalls = [];
    state.retryDispatchRows = [];
    state.env.GITHUB_APP_TOKEN = 'ghp_test';
    state.env.TASK_RETRY_MAX = 3;
    state.env.RETRY_STALL_MS = 600_000;
  };
  reset();

  const adapter = { sendTurn: vi.fn() };
  const getAdapter = vi.fn(() => adapter);
  const resolveGateFlags = vi.fn(async () => ({ aiReviewEnabled: false, selfVerifyEnabled: false }));
  const octokit = {
    pulls: { get: vi.fn() },
    checks: { listForRef: vi.fn() },
  };

  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if (!selection) return Promise.resolve(state.awaitingTasks);
          if ('backend' in selection) {
            return { limit: vi.fn(async () => (state.missionRow ? [state.missionRow] : [])) };
          }
          // The ci.retry_dispatched lookup (latestRetryDispatch) chains
          // .orderBy(...).limit(1); state.retryDispatchRows lets a test seed a
          // prior retry so the SHA-gating branches can be exercised.
          const rows = vi.fn(async () => state.retryDispatchRows);
          return {
            limit: rows,
            orderBy: vi.fn(() => ({ limit: rows })),
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Partial<Task>) => {
        state.taskUpdateCalls.push(values);
        // `.where()` is awaited directly by most call sites, but the
        // needs_human escalation chains `.returning()` off it for its CAS —
        // so return a thenable that also exposes returning().
        const rows = [{ id: 'tsk_1' }];
        return {
          where: vi.fn(() => ({
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
            returning: vi.fn(async () => rows),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return { adapter, db, getAdapter, octokit, reset, resolveGateFlags, state };
});

vi.mock('@/lib/db', () => ({ db: ciMocks.db }));
vi.mock('@/lib/env', () => ({ env: ciMocks.state.env }));
vi.mock('./adapters', () => ({ getAdapter: ciMocks.getAdapter }));
vi.mock('./gate-flags', () => ({ resolveGateFlags: ciMocks.resolveGateFlags }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => ciMocks.octokit) }));

function ciTask(overrides: Partial<Task> = {}): Task {
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
    status: 'awaiting_ci',
    sessionId: 'ses_original',
    backendSessionRef: 'ses_original',
    prUrl: 'https://github.com/acme/repo/pull/42',
    prNumber: 42,
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

const failingCheckRun = {
  status: 'completed',
  conclusion: 'failure',
  name: 'test-suite',
  details_url: null,
  output: null,
};

describe('retryWithFeedback (via runCiPoller)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    ciMocks.reset();
    ciMocks.octokit.pulls.get.mockResolvedValue({ data: { head: { sha: 'sha_1' } } });
    ciMocks.octokit.checks.listForRef.mockResolvedValue({
      data: { total_count: 1, check_runs: [failingCheckRun] },
    });
  });

  it('persists the rotated backendSessionRef from sendTurn, leaving sessionId untouched', async () => {
    ciMocks.state.awaitingTasks = [ciTask()];
    ciMocks.adapter.sendTurn.mockResolvedValue({ backendSessionRef: 'v1_rotated' });

    const result = await runCiPoller(log);

    expect(result.retried).toBe(1);
    expect(ciMocks.state.taskUpdateCalls).toHaveLength(1);
    const payload = ciMocks.state.taskUpdateCalls[0]!;
    expect(payload.backendSessionRef).toBe('v1_rotated');
    expect(payload.retryCount).toBe(1);
    expect(payload).not.toHaveProperty('sessionId');
  });

  it('leaves backendSessionRef unwritten when sendTurn throws (falls through to marking the task failed)', async () => {
    ciMocks.state.awaitingTasks = [ciTask()];
    ciMocks.adapter.sendTurn.mockRejectedValue(new Error('backend unreachable'));

    const result = await runCiPoller(log);

    expect(result.transitionedToFailed).toBe(1);
    expect(ciMocks.state.taskUpdateCalls).toHaveLength(1);
    const payload = ciMocks.state.taskUpdateCalls[0]!;
    expect(payload).not.toHaveProperty('backendSessionRef');
    expect(payload).not.toHaveProperty('sessionId');
    expect(payload.status).toBe('failed');
  });
});

// --- the retry storm (#60) ---
//
// The tick re-evaluates the same failing CI result every 60s. Gating only on
// retryCount re-sent the failure to the agent on EVERY tick, burning a
// 3-retry budget in ~90s while the agent was still working — observed live on
// PR #59 (two identical "CI failed" messages, retryCount 1→2→3, task failed
// with the PR still at one commit). Retries are now gated on the PR head SHA.
describe('CI retry gating (#60)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    ciMocks.reset();
    ciMocks.octokit.pulls.get.mockResolvedValue({ data: { head: { sha: 'sha_1' } } });
    ciMocks.octokit.checks.listForRef.mockResolvedValue({
      data: { total_count: 1, check_runs: [failingCheckRun] },
    });
    ciMocks.adapter.sendTurn.mockResolvedValue({});
  });

  it('does not resend for a SHA it already retried — the agent is still working', async () => {
    ciMocks.state.awaitingTasks = [ciTask({ retryCount: 1 })];
    ciMocks.state.retryDispatchRows = [
      { payload: { sha: 'sha_1' }, createdAt: new Date(Date.now() - 60_000) }, // 1 min ago
    ];

    const result = await runCiPoller(log);

    expect(ciMocks.adapter.sendTurn).not.toHaveBeenCalled();
    expect(result.retried).toBe(0);
    expect(result.stillPending).toBe(1);
    // Nothing changed, so the task must not be written at all.
    expect(ciMocks.state.taskUpdateCalls).toHaveLength(0);
  });

  it('sends again once the agent pushes a new SHA', async () => {
    ciMocks.state.awaitingTasks = [ciTask({ retryCount: 1 })];
    ciMocks.state.retryDispatchRows = [
      { payload: { sha: 'sha_OLD' }, createdAt: new Date(Date.now() - 60_000) },
    ];

    const result = await runCiPoller(log);

    expect(ciMocks.adapter.sendTurn).toHaveBeenCalledTimes(1);
    expect(result.retried).toBe(1);
    expect(ciMocks.state.taskUpdateCalls[0]!.retryCount).toBe(2);
  });

  it('escalates to needs_human when the retried SHA has not moved for RETRY_STALL_MS', async () => {
    // Without this, SHA-gating would trade the storm for a permanent wedge:
    // awaiting_ci is not in the reconciler's gate-stall sweep.
    ciMocks.state.awaitingTasks = [ciTask({ retryCount: 1 })];
    ciMocks.state.retryDispatchRows = [
      { payload: { sha: 'sha_1' }, createdAt: new Date(Date.now() - 700_000) }, // > 10 min
    ];

    const result = await runCiPoller(log);

    expect(ciMocks.adapter.sendTurn).not.toHaveBeenCalled();
    expect(result.transitionedToFailed).toBe(1);
    const payload = ciMocks.state.taskUpdateCalls[0]!;
    expect(payload.status).toBe('needs_human');
    expect(payload.escalationReason).toBe('ci_retry_stalled');
  });
});
