import { describe, expect, it, beforeEach, vi } from 'vitest';

import { NoObjectGeneratedError } from 'ai';

import type { Task } from '@forge/db';

import { buildVerifyFeedback, buildVerifyPrompt, runVerify } from './verify';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});

describe('buildVerifyPrompt', () => {
  it('embeds the criteria and the diff and asks for completeness only', () => {
    const p = buildVerifyPrompt('- a PR is open', 'diff --git a b');
    expect(p).toContain('- a PR is open');
    expect(p).toContain('diff --git a b');
    expect(p).toContain('completeness only');
  });
});

describe('buildVerifyFeedback', () => {
  it('surfaces the missing items and asks the agent to push', () => {
    const f = buildVerifyFeedback('the lockfile was not updated');
    expect(f).toContain('the lockfile was not updated');
    expect(f).toContain('push');
  });
});

describe('requestVerdict', () => {
  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it('returns the schema-shaped verdict and token usage on success', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { verdict: 'done' },
      usage: { inputTokens: 200, outputTokens: 10 },
    });

    const { requestVerdict } = await import('./verify');
    const { verdict, tokensUsed } = await requestVerdict({
      acceptanceCriteria: '- a PR is open',
      diff: 'diff --git a b',
      model: 'claude-haiku-4-5',
    });

    expect(verdict).toEqual({ verdict: 'done' });
    expect(tokensUsed).toBe(210);
  });

  it('falls back to incomplete when the model returns an unparseable object', async () => {
    mocks.generateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        text: 'garbage',
        response: {} as never,
        usage: { inputTokens: 30, outputTokens: 5 } as never,
        finishReason: 'stop',
      }),
    );

    const { requestVerdict } = await import('./verify');
    const { verdict, tokensUsed } = await requestVerdict({
      acceptanceCriteria: '- a PR is open',
      diff: 'diff --git a b',
      model: 'claude-haiku-4-5',
    });

    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.missing).toContain('unparseable verifier response');
    expect(verdict.missing).toContain('garbage');
    expect(tokensUsed).toBe(35);
  });
});

// --- verifyOne's retry path (private, exercised through the exported runVerify) ---
//
// `verifyOne` isn't exported, so we drive it end-to-end via `runVerify`: seed
// one `awaiting_verify` task, make the (mocked) checker model return
// "incomplete", and assert on the payload `db.update` receives — this is
// what guards against a typo like writing `task.sessionId` instead of
// `result.backendSessionRef`, or dropping the field entirely.
const vfMocks = vi.hoisted(() => {
  const state = {
    awaitingTasks: [] as Task[],
    missionRow: undefined as { backend: string; skillId: string | null } | undefined,
    taskUpdateCalls: [] as Array<Partial<Task>>,
    env: {
      GITHUB_APP_TOKEN: 'ghp_test' as string | undefined,
      VERIFY_MODEL: 'claude-haiku-4-5',
      VERIFY_RETRY_MAX: 3,
    },
  };

  const reset = () => {
    state.awaitingTasks = [];
    state.missionRow = { backend: 'managed-agents', skillId: null };
    state.taskUpdateCalls = [];
    state.env.GITHUB_APP_TOKEN = 'ghp_test';
    state.env.VERIFY_MODEL = 'claude-haiku-4-5';
    state.env.VERIFY_RETRY_MAX = 3;
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
          if ('backend' in selection || 'skillId' in selection) {
            return { limit: vi.fn(async () => (state.missionRow ? [state.missionRow] : [])) };
          }
          return { limit: vi.fn(async () => []) };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Partial<Task>) => {
        state.taskUpdateCalls.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return { adapter, db, getAdapter, octokit, reset, resolveGateFlags, state };
});

vi.mock('@/lib/db', () => ({ db: vfMocks.db }));
vi.mock('@/lib/env', () => ({ env: vfMocks.state.env }));
vi.mock('./adapters', () => ({ getAdapter: vfMocks.getAdapter }));
vi.mock('./gate-flags', () => ({ resolveGateFlags: vfMocks.resolveGateFlags }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => vfMocks.octokit) }));

function vfTask(overrides: Partial<Task> = {}): Task {
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
    status: 'awaiting_verify',
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
    acceptanceCriteria: '- must add tests',
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

describe('verifyOne retry path (via runVerify)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vfMocks.reset();
    mocks.generateObject.mockReset();
    vfMocks.octokit.pulls.get
      .mockResolvedValueOnce({ data: { head: { sha: 'sha_1' } } })
      .mockResolvedValueOnce({ data: '+diff content' });
    vfMocks.octokit.checks.listForRef.mockResolvedValue({ data: { total_count: 0, check_runs: [] } });
    mocks.generateObject.mockResolvedValue({
      object: { verdict: 'incomplete', missing: 'lockfile not updated' },
      usage: { inputTokens: 20, outputTokens: 5 },
    });
  });

  it('persists the rotated backendSessionRef from sendTurn, leaving sessionId untouched', async () => {
    vfMocks.state.awaitingTasks = [vfTask()];
    vfMocks.adapter.sendTurn.mockResolvedValue({ backendSessionRef: 'v1_rotated' });

    const result = await runVerify(log);

    expect(result.retried).toBe(1);
    const backendSessionRefCall = vfMocks.state.taskUpdateCalls.find(
      (call) => 'backendSessionRef' in call,
    );
    expect(backendSessionRefCall?.backendSessionRef).toBe('v1_rotated');
    for (const call of vfMocks.state.taskUpdateCalls) {
      expect(call).not.toHaveProperty('sessionId');
    }
  });

  it('leaves backendSessionRef unwritten when sendTurn throws', async () => {
    vfMocks.state.awaitingTasks = [vfTask()];
    vfMocks.adapter.sendTurn.mockRejectedValue(new Error('backend unreachable'));

    const result = await runVerify(log);

    expect(result.retried).toBe(1);
    for (const call of vfMocks.state.taskUpdateCalls) {
      expect(call).not.toHaveProperty('backendSessionRef');
      expect(call).not.toHaveProperty('sessionId');
    }
  });
});

// --- verifyOne's escalation branches (private, exercised through runVerify) ---
//
// All three call sites that escalate a Task (no acceptance criteria, no new
// push since the last verify feedback, and retries exhausted) funnel through
// the same `escalate` helper, which must always write
// status: 'needs_human' + escalationReason: 'verify_incomplete'. A reviewer
// verified this by reading source; nothing encoded it until now.
describe('verifyOne escalate paths (via runVerify)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vfMocks.reset();
    mocks.generateObject.mockReset();
    // mockReset (not just clearAllMocks) drains any queued mockResolvedValueOnce
    // values left over from a previous test in this describe — the
    // "no acceptance criteria" case never calls pulls.get, so without this its
    // queued once-values would bleed into a later test's call sequence.
    vfMocks.octokit.pulls.get.mockReset();
    vfMocks.octokit.pulls.get
      .mockResolvedValueOnce({ data: { head: { sha: 'sha_1' } } })
      .mockResolvedValueOnce({ data: '+diff content' });
    vfMocks.octokit.checks.listForRef.mockResolvedValue({ data: { total_count: 0, check_runs: [] } });
    mocks.generateObject.mockResolvedValue({
      object: { verdict: 'incomplete', missing: 'lockfile not updated' },
      usage: { inputTokens: 20, outputTokens: 5 },
    });
  });

  function expectEscalatedWithVerifyIncomplete(result: { escalated: number }) {
    expect(result.escalated).toBe(1);
    const escalateCall = vfMocks.state.taskUpdateCalls.find((call) => call.status === 'needs_human');
    expect(escalateCall?.status).toBe('needs_human');
    expect(escalateCall?.escalationReason).toBe('verify_incomplete');
  }

  it('escalates when the task has no acceptance criteria', async () => {
    vfMocks.state.awaitingTasks = [vfTask({ acceptanceCriteria: null })];

    const result = await runVerify(log);

    expectEscalatedWithVerifyIncomplete(result);
  });

  it('escalates when HEAD has not moved since the last verify pass (no new push)', async () => {
    vfMocks.state.awaitingTasks = [vfTask({ lastVerifiedSha: 'sha_1' })];

    const result = await runVerify(log);

    expectEscalatedWithVerifyIncomplete(result);
  });

  it('escalates once verify retries are exhausted', async () => {
    vfMocks.state.awaitingTasks = [vfTask({ verifyRetryCount: 3 })];

    const result = await runVerify(log);

    expectEscalatedWithVerifyIncomplete(result);
  });
});
