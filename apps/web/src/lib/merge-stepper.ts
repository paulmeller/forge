import type { TaskStatus } from '@forge/db';

export type StepState = 'done' | 'active' | 'upcoming';

export type MergeStepperState =
  | { kind: 'hidden' }
  | { kind: 'failed' }
  | { kind: 'steps'; ci: StepState; merge: StepState; needsAttention: boolean };

const PAST_CI = new Set<TaskStatus>([
  'awaiting_verify',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
]);

/**
 * Derives an honest 2-step CI -> Merge display from the task's real status.
 * Deliberately excludes a "Review" step: Forge does not fetch GitHub's
 * review_decision/mergeable_state anywhere, so there is no real signal to
 * show one. `awaiting_review` (Forge's internal "escalated to a human for
 * any reason" state) surfaces via `needsAttention` instead of a fake step.
 */
export function deriveMergeStepper(status: TaskStatus, prUrl: string | null): MergeStepperState {
  if (!prUrl) return { kind: 'hidden' };
  if (status === 'failed') return { kind: 'failed' };

  if (status === 'awaiting_ci') {
    return { kind: 'steps', ci: 'active', merge: 'upcoming', needsAttention: false };
  }
  if (PAST_CI.has(status)) {
    return {
      kind: 'steps',
      ci: 'done',
      merge: status === 'merged' ? 'done' : status === 'merging' ? 'active' : 'upcoming',
      needsAttention: status === 'awaiting_review',
    };
  }

  // queued/dispatching/running/turn_ended/opening_pr/resolved/abandoned:
  // a PR shouldn't realistically exist yet (or the task is done/abandoned
  // via a path that doesn't need this display) — hide rather than guess.
  return { kind: 'hidden' };
}
