import { describe, expect, it } from 'vitest';

import { buildReviewPrompt, runAiReview } from './ai-review';

describe('buildReviewPrompt', () => {
  it('includes the mission goal', () => {
    const prompt = buildReviewPrompt({ goal: 'bump lodash', diff: '+foo', summary: '' });
    expect(prompt).toContain('bump lodash');
  });

  it('includes the diff', () => {
    const prompt = buildReviewPrompt({ goal: 'fix', diff: '+added line', summary: '' });
    expect(prompt).toContain('+added line');
  });
});

import { NoObjectGeneratedError } from 'ai';
import { beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});

describe('requestReview', () => {
  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it('returns the schema-shaped review and token usage on success', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { decision: 'approve', feedback: 'looks good' },
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const { requestReview } = await import('./ai-review');
    const { review, tokensUsed } = await requestReview({
      goal: 'bump lodash',
      diff: '+foo',
      summary: '',
    });

    expect(review).toEqual({ decision: 'approve', feedback: 'looks good' });
    expect(tokensUsed).toBe(120);
  });

  it('falls back to a safe reject when the model returns an unparseable object', async () => {
    mocks.generateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        text: 'not valid json',
        response: {} as never,
        usage: { inputTokens: 50, outputTokens: 5 } as never,
        finishReason: 'stop',
      }),
    );

    const { requestReview } = await import('./ai-review');
    const { review, tokensUsed } = await requestReview({
      goal: 'bump lodash',
      diff: '+foo',
      summary: '',
    });

    expect(review.decision).toBe('reject');
    expect(review.feedback).toContain('unparseable response from AI reviewer');
    expect(review.feedback).toContain('not valid json');
    expect(tokensUsed).toBe(55);
  });
});

// --- reviewOne's reject path (private, exercised through the exported runAiReview) ---
//
// `reviewOne` isn't exported, so we drive it end-to-end via `runAiReview`:
// seed one `awaiting_ai_review` task, make the (mocked) model reject, and
// assert on the payload `db.update` receives — this is what guards against a
// typo like writing `task.sessionId` instead of `result.backendSessionRef`,
// or dropping the field entirely.
import type { Task } from '@forge/db';

const arMocks = vi.hoisted(() => {
  const state = {
    awaitingTasks: [] as Task[],
    missionRow: undefined as { goal: string; backend: string } | undefined,
    taskUpdateCalls: [] as Array<Partial<Task>>,
    env: { GITHUB_APP_TOKEN: 'ghp_test' as string | undefined },
  };

  const reset = () => {
    state.awaitingTasks = [];
    state.missionRow = { goal: 'bump lodash', backend: 'managed-agents' };
    state.taskUpdateCalls = [];
    state.env.GITHUB_APP_TOKEN = 'ghp_test';
  };
  reset();

  const adapter = { sendTurn: vi.fn() };
  const getAdapter = vi.fn(() => adapter);
  const octokit = { pulls: { get: vi.fn() } };

  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if (!selection) return Promise.resolve(state.awaitingTasks);
          if ('goal' in selection) {
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

  return { adapter, db, getAdapter, octokit, reset, state };
});

vi.mock('@/lib/db', () => ({ db: arMocks.db }));
vi.mock('@/lib/env', () => ({ env: arMocks.state.env }));
vi.mock('./adapters', () => ({ getAdapter: arMocks.getAdapter }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => arMocks.octokit) }));

function arTask(overrides: Partial<Task> = {}): Task {
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
    status: 'awaiting_ai_review',
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

describe('reviewOne reject path (via runAiReview)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    arMocks.reset();
    mocks.generateObject.mockReset();
    arMocks.octokit.pulls.get.mockResolvedValue({ data: '+diff content' });
    mocks.generateObject.mockResolvedValue({
      object: { decision: 'reject', feedback: 'please add tests' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('persists the rotated backendSessionRef from sendTurn, leaving sessionId untouched', async () => {
    arMocks.state.awaitingTasks = [arTask()];
    arMocks.adapter.sendTurn.mockResolvedValue({ backendSessionRef: 'v1_rotated' });

    const result = await runAiReview(log);

    expect(result.rejected).toBe(1);
    const backendSessionRefCall = arMocks.state.taskUpdateCalls.find(
      (call) => 'backendSessionRef' in call,
    );
    expect(backendSessionRefCall?.backendSessionRef).toBe('v1_rotated');
    for (const call of arMocks.state.taskUpdateCalls) {
      expect(call).not.toHaveProperty('sessionId');
    }
  });

  it('leaves backendSessionRef unwritten when sendTurn throws', async () => {
    arMocks.state.awaitingTasks = [arTask()];
    arMocks.adapter.sendTurn.mockRejectedValue(new Error('backend unreachable'));

    const result = await runAiReview(log);

    expect(result.rejected).toBe(1);
    for (const call of arMocks.state.taskUpdateCalls) {
      expect(call).not.toHaveProperty('backendSessionRef');
      expect(call).not.toHaveProperty('sessionId');
    }
  });
});

// --- reviewOne's retries-exhausted escalation branch (private, exercised
// through runAiReview) ---
//
// Once aiReviewRetryCount has hit the retry cap, a further rejection must
// escalate to a human rather than retry again. This guards the
// status/escalationReason mapping `escalateTask` writes — a reviewer
// verified it by reading source, but nothing encoded it until now.
describe('reviewOne escalate path (via runAiReview)', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    arMocks.reset();
    mocks.generateObject.mockReset();
    arMocks.octokit.pulls.get.mockResolvedValue({ data: '+diff content' });
    mocks.generateObject.mockResolvedValue({
      object: { decision: 'reject', feedback: 'still not good enough' },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('escalates to needs_human with escalationReason ai_review_rejected once retries are exhausted', async () => {
    arMocks.state.awaitingTasks = [arTask({ aiReviewRetryCount: 3 })];

    const result = await runAiReview(log);

    expect(result.escalated).toBe(1);
    const escalateCall = arMocks.state.taskUpdateCalls.find((call) => call.status === 'needs_human');
    expect(escalateCall?.status).toBe('needs_human');
    expect(escalateCall?.escalationReason).toBe('ai_review_rejected');
  });
});
