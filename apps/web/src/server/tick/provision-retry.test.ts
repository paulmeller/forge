import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bug this pins (#92): a session that dies before the agent's first turn
// (harness bootstrap ENOSPC, a concurrent-provisioning OOM-kill) costs zero
// tokens and is almost always transient — but today it's treated exactly
// like an agent that ran and failed: permanent `failed`/`abandoned`, which
// cascade-fails the dependent Task too (DEPENDENCY_FAILED_STATUSES). Observed
// live twice in one day, seven tasks each time, all at zero token cost.
// isPreAgentFailure/decideProvisionRetry below are what let dispatcher.ts and
// poller.ts tell "the agent never got a turn" apart from "the agent ran and
// failed", and bound how many free retries that transient failure gets.

const mocks = vi.hoisted(() => {
  const state = {
    // Each entry is the row `latestProvisionRetry`'s select().orderBy().limit(1)
    // should return for the NEXT call, consumed in order — one call per
    // requeueOrAbandon/shouldWaitForProvisionBackoff invocation.
    latestRetryQueue: [] as Array<{ attempt: number; at: Date } | null>,
    updateSetCalls: [] as Array<Record<string, unknown>>,
    insertedLedgerEvents: [] as Array<Record<string, unknown>>,
  };

  const reset = () => {
    state.latestRetryQueue = [];
    state.updateSetCalls = [];
    state.insertedLedgerEvents = [];
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const next = state.latestRetryQueue.shift();
              if (!next) return [];
              return [{ payload: { attempt: next.attempt }, createdAt: next.at }];
            }),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updateSetCalls.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        state.insertedLedgerEvents.push(row);
      }),
    })),
  };

  return { db, state, reset };
});

vi.mock('@/lib/db', () => ({ db: mocks.db }));

import {
  decideProvisionRetry,
  isPreAgentFailure,
  PROVISION_RETRY_BASE_MS,
  PROVISION_RETRY_MAX,
  requeueOrAbandon,
  shouldWaitForProvisionBackoff,
} from './provision-retry';

const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  mocks.reset();
  vi.clearAllMocks();
});

describe('isPreAgentFailure (the pre-agent classifier)', () => {
  it('is true for the harness-bootstrap ENOSPC shape at zero tokens', () => {
    expect(
      isPreAgentFailure(
        'managed-agents session sess_1 failed during provisioning: bootstrap failed: ENOSPC: no space left on device',
        0,
      ),
    ).toBe(true);
  });

  it('is true for an OOM-kill (exit 137) shape at zero tokens', () => {
    expect(isPreAgentFailure('sandbox setup killed: pnpm install exit code 137 (OOM)', 0)).toBe(
      true,
    );
  });

  it('is true for a clone failure shape at zero tokens', () => {
    expect(isPreAgentFailure('failed to clone repository: authentication failed', 0)).toBe(true);
  });

  it('is false once any tokens were spent — the agent ran, this is not provisioning', () => {
    expect(isPreAgentFailure('bootstrap failed: ENOSPC: no space left on device', 1)).toBe(false);
  });

  it('is false for an unrelated error even at zero tokens', () => {
    expect(isPreAgentFailure('rate limit exceeded', 0)).toBe(false);
  });

  it('is false with no message', () => {
    expect(isPreAgentFailure(null, 0)).toBe(false);
    expect(isPreAgentFailure(undefined, 0)).toBe(false);
  });
});

describe('decideProvisionRetry (the attempt bound)', () => {
  const now = new Date('2026-01-01T00:10:00.000Z');

  it('retries immediately on the first failure (no prior attempt)', () => {
    expect(decideProvisionRetry({ attempt: 0, lastAttemptAt: null, now })).toBe('retry');
  });

  it('waits before the doubling delay has elapsed', () => {
    const lastAttemptAt = new Date(now.getTime() - 10_000); // 10s ago
    expect(decideProvisionRetry({ attempt: 1, lastAttemptAt, now, baseDelayMs: 60_000 })).toBe(
      'wait',
    );
  });

  it('retries once the doubling delay has elapsed', () => {
    const lastAttemptAt = new Date(now.getTime() - 60_000); // exactly one base delay ago
    expect(decideProvisionRetry({ attempt: 1, lastAttemptAt, now, baseDelayMs: 60_000 })).toBe(
      'retry',
    );
  });

  it('doubles the delay on each subsequent attempt', () => {
    // attempt 2 already spent → delay is base * 2^1 = 120s, not base * 2^0 = 60s
    expect(
      decideProvisionRetry({
        attempt: 2,
        lastAttemptAt: new Date(now.getTime() - 90_000),
        now,
        baseDelayMs: 60_000,
      }),
    ).toBe('wait');
    expect(
      decideProvisionRetry({
        attempt: 2,
        lastAttemptAt: new Date(now.getTime() - 120_000),
        now,
        baseDelayMs: 60_000,
      }),
    ).toBe('retry');
  });

  it('is exhausted at exactly the attempt bound, regardless of elapsed time', () => {
    expect(
      decideProvisionRetry({
        attempt: 3,
        lastAttemptAt: new Date(now.getTime() - 10_000_000),
        now,
        maxAttempts: 3,
      }),
    ).toBe('exhausted');
  });

  it('is not yet exhausted one attempt below the bound', () => {
    expect(decideProvisionRetry({ attempt: 2, lastAttemptAt: null, now, maxAttempts: 3 })).toBe(
      'retry',
    );
  });

  it('defaults to PROVISION_RETRY_MAX / PROVISION_RETRY_BASE_MS', () => {
    expect(PROVISION_RETRY_MAX).toBe(3);
    expect(PROVISION_RETRY_BASE_MS).toBeGreaterThan(0);
  });
});

describe('requeueOrAbandon', () => {
  const task = {
    id: 'tsk_1',
    missionId: 'mis_1',
    costTokens: 0,
  } as never;

  it('requeues a first-time provisioning failure instead of abandoning it', async () => {
    mocks.state.latestRetryQueue.push(null); // no prior attempt

    await requeueOrAbandon(task, 'bootstrap failed: ENOSPC: no space left on device', log);

    expect(mocks.state.updateSetCalls).toHaveLength(1);
    expect(mocks.state.updateSetCalls[0]).toMatchObject({ status: 'queued', sessionId: null });

    expect(mocks.state.insertedLedgerEvents).toHaveLength(1);
    expect(mocks.state.insertedLedgerEvents[0]).toMatchObject({
      taskId: 'tsk_1',
      eventType: 'task.provision_retry',
      payload: { attempt: 1 },
    });
  });

  it('grants up to PROVISION_RETRY_MAX retries, then abandons with the last error', async () => {
    // PROVISION_RETRY_MAX prior retries already recorded — this failure is one too many.
    mocks.state.latestRetryQueue.push({
      attempt: PROVISION_RETRY_MAX,
      at: new Date('2026-01-01T00:05:00.000Z'),
    });

    await requeueOrAbandon(task, 'bootstrap failed: ENOSPC: no space left on device (final)', log);

    expect(mocks.state.updateSetCalls.at(-1)).toMatchObject({
      status: 'failed',
      lastError: 'bootstrap failed: ENOSPC: no space left on device (final)',
    });
    expect(mocks.state.insertedLedgerEvents.at(-1)).toMatchObject({
      eventType: 'task.provision_exhausted',
    });
  });
});

describe('shouldWaitForProvisionBackoff', () => {
  it('is false when the Task has no provisioning-retry history', async () => {
    mocks.state.latestRetryQueue.push(null);
    await expect(shouldWaitForProvisionBackoff('tsk_2', new Date())).resolves.toBe(false);
  });

  it('is true while inside the backoff window of the most recent retry', async () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    mocks.state.latestRetryQueue.push({ attempt: 1, at: new Date(now.getTime() - 5_000) });
    await expect(shouldWaitForProvisionBackoff('tsk_3', now)).resolves.toBe(true);
  });
});
