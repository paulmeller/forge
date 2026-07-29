import { describe, expect, it } from 'vitest';

import { decideCiRetry } from './ci-retry';

// The bug this pins: the tick re-evaluates the same failing CI result every
// 60s, so gating only on retryCount burned a 3-retry budget in ~90s and the
// agent (interrupted each tick) never got to push a fix. Observed live on
// PR #59: two identical "CI failed" messages, retryCount 1→2→3, task failed
// with the PR still at one commit.

const BASE = {
  retryCount: 0,
  maxRetries: 3,
  stallMs: 600_000,
  now: new Date('2026-01-01T00:10:00.000Z'),
};

describe('decideCiRetry', () => {
  it('sends on a failing SHA it has not retried yet', () => {
    expect(
      decideCiRetry({ ...BASE, headSha: 'sha_a', lastRetrySha: null, lastRetryAt: null }),
    ).toBe('send');
  });

  it('does NOT resend for a SHA it already retried — one retry per fix attempt, not per tick', () => {
    expect(
      decideCiRetry({
        ...BASE,
        headSha: 'sha_a',
        lastRetrySha: 'sha_a',
        lastRetryAt: new Date('2026-01-01T00:09:00.000Z'), // 1 min ago
        retryCount: 1,
      }),
    ).toBe('wait');
  });

  it('sends again once the agent pushes a new SHA', () => {
    // The head SHA moving is the honest signal that an attempt really happened.
    expect(
      decideCiRetry({
        ...BASE,
        headSha: 'sha_b',
        lastRetrySha: 'sha_a',
        lastRetryAt: new Date('2026-01-01T00:09:00.000Z'),
        retryCount: 1,
      }),
    ).toBe('send');
  });

  it('escalates when the retried SHA has not moved for stallMs — the agent is not coming back', () => {
    // Without this, SHA-gating would trade a retry storm for a permanent wedge:
    // awaiting_ci is deliberately not in the reconciler's gate-stall sweep.
    expect(
      decideCiRetry({
        ...BASE,
        headSha: 'sha_a',
        lastRetrySha: 'sha_a',
        lastRetryAt: new Date('2026-01-01T00:00:00.000Z'), // 10 min ago
        retryCount: 1,
      }),
    ).toBe('escalate');
  });

  it('reports the budget exhausted only for a genuinely new failing SHA', () => {
    // retryCount now counts real fix attempts, so hitting max means the agent
    // pushed maxRetries times and CI still failed.
    expect(
      decideCiRetry({
        ...BASE,
        headSha: 'sha_d',
        lastRetrySha: 'sha_c',
        lastRetryAt: new Date('2026-01-01T00:09:00.000Z'),
        retryCount: 3,
      }),
    ).toBe('exhausted');
  });

  it('waits rather than exhausting when the budget is spent but the SHA is unchanged', () => {
    // The budget is only consumed by new SHAs, so a spent budget on an already
    // retried SHA must not skip straight to failure while the agent works.
    expect(
      decideCiRetry({
        ...BASE,
        headSha: 'sha_c',
        lastRetrySha: 'sha_c',
        lastRetryAt: new Date('2026-01-01T00:09:30.000Z'),
        retryCount: 3,
      }),
    ).toBe('wait');
  });
});
