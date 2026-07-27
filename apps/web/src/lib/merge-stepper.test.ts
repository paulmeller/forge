import { describe, expect, it } from 'vitest';

import { deriveMergeStepper } from './merge-stepper';

const PR = 'https://github.com/o/r/pull/1';

describe('deriveMergeStepper', () => {
  it('is hidden when there is no PR yet', () => {
    expect(deriveMergeStepper('running', null, null)).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('opening_pr', null, null)).toEqual({ kind: 'hidden' });
  });

  it('shows CI active, review and merge upcoming while awaiting_ci', () => {
    expect(deriveMergeStepper('awaiting_ci', PR, null)).toEqual({
      kind: 'steps',
      ci: 'active',
      review: 'upcoming',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, review active, merge upcoming, and needsAttention for needs_human', () => {
    expect(deriveMergeStepper('needs_human', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'active',
      merge: 'upcoming',
      needsAttention: true,
    });
  });

  it('shows CI done, review active, merge upcoming (no attention) for internal gate statuses', () => {
    expect(deriveMergeStepper('awaiting_verify', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'active',
      merge: 'upcoming',
      needsAttention: false,
    });
    expect(deriveMergeStepper('awaiting_ai_review', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'active',
      merge: 'upcoming',
      needsAttention: false,
    });
    expect(deriveMergeStepper('ready_to_merge', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'active',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, merge active while merging', () => {
    expect(deriveMergeStepper('merging', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'active',
      merge: 'active',
      needsAttention: false,
    });
  });

  it('shows both CI and review done once merged, regardless of reviewDecision', () => {
    expect(deriveMergeStepper('merged', PR, null)).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'done',
      merge: 'done',
      needsAttention: false,
    });
  });

  // A task can merge while `changes_requested` still stood (e.g. a human
  // merged anyway, or the review event arrived after the merge sweep had
  // already settled the task) — a settled, positive `merged` outcome must
  // never be flagged for attention on that account. Revert the `status !==
  // 'merged'` guard in merge-stepper.ts and this test fails: needsAttention
  // comes back true alongside review: 'done'.
  it('does not flag a merged task for attention even when changes_requested was the last review event', () => {
    expect(deriveMergeStepper('merged', PR, 'changes_requested')).toEqual({
      kind: 'steps',
      ci: 'done',
      review: 'done',
      merge: 'done',
      needsAttention: false,
    });
  });

  it('is a distinct failed state for failed status, not attributed to a specific step', () => {
    expect(deriveMergeStepper('failed', PR, null)).toEqual({ kind: 'failed' });
  });

  it('is hidden for statuses that should never have a PR yet', () => {
    expect(deriveMergeStepper('queued', PR, null)).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('resolved', PR, null)).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('abandoned', PR, null)).toEqual({ kind: 'hidden' });
  });

  it('shows Review as active while a PR is unreviewed', () => {
    const s = deriveMergeStepper('ready_to_merge', PR, null);
    expect(s).toMatchObject({ kind: 'steps', ci: 'done', review: 'active', merge: 'upcoming' });
  });

  it('shows Review as done once approved', () => {
    const s = deriveMergeStepper('ready_to_merge', PR, 'approved');
    expect(s).toMatchObject({ kind: 'steps', review: 'done' });
  });

  it('flags attention when changes are requested', () => {
    const s = deriveMergeStepper('ready_to_merge', PR, 'changes_requested');
    expect(s).toMatchObject({ kind: 'steps', review: 'active', needsAttention: true });
  });

  it('does not report review done merely because CI passed, absent a reviewDecision', () => {
    const s = deriveMergeStepper('ready_to_merge', PR, null);
    expect(s).toMatchObject({ review: 'active' });
    expect(s).not.toMatchObject({ review: 'done' });
  });
});
