import { describe, expect, it } from 'vitest';

import { deriveMergeStepper } from './merge-stepper';

describe('deriveMergeStepper', () => {
  it('is hidden when there is no PR yet', () => {
    expect(deriveMergeStepper('running', null)).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('opening_pr', null)).toEqual({ kind: 'hidden' });
  });

  it('shows CI active, merge upcoming while awaiting_ci', () => {
    expect(deriveMergeStepper('awaiting_ci', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'active',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, merge upcoming, and needsAttention for awaiting_review', () => {
    expect(deriveMergeStepper('awaiting_review', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: true,
    });
  });

  it('shows CI done, merge upcoming (no attention) for internal gate statuses', () => {
    expect(deriveMergeStepper('awaiting_verify', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: false,
    });
    expect(deriveMergeStepper('awaiting_ai_review', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, merge active while merging', () => {
    expect(deriveMergeStepper('merging', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'active',
      needsAttention: false,
    });
  });

  it('shows both done once merged', () => {
    expect(deriveMergeStepper('merged', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'done',
      needsAttention: false,
    });
  });

  it('is a distinct failed state for failed status, not attributed to a specific step', () => {
    expect(deriveMergeStepper('failed', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'failed' });
  });

  it('is hidden for statuses that should never have a PR yet', () => {
    expect(deriveMergeStepper('queued', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('resolved', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('abandoned', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
  });
});
