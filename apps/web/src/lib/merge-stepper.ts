import type { ReviewDecision, TaskStatus } from '@forge/db';

export type StepState = 'done' | 'active' | 'upcoming';

export type MergeStepperState =
  | { kind: 'hidden' }
  | { kind: 'failed' }
  | {
      kind: 'steps';
      ci: StepState;
      review: StepState;
      merge: StepState;
      needsAttention: boolean;
    };

const PAST_CI = new Set<TaskStatus>([
  'awaiting_verify',
  'awaiting_ai_review',
  'ready_to_merge',
  'needs_human',
  'merging',
  'merged',
]);

/**
 * Derives a 3-step CI -> Review -> Merge display from the task's real state.
 *
 * The Review step is driven by `reviewDecision`, mirrored from GitHub's
 * pull_request_review events. Before those were subscribed there was no
 * signal to drive it, which is why this used to be an honest 2-step display.
 *
 * `reviewDecision` is a best-effort *indicator*, not an authority: it's a
 * single scalar reflecting the most recent review event, not an aggregate of
 * the PR's reviews (see the KNOWN LIMITATION comment on the schema column),
 * and it is only populated once an operator has subscribed the GitHub App to
 * `pull_request_review` events. In practice it may be null for a PR that
 * already has a standing approval on GitHub — the Review step reflects "no
 * review signal seen yet," not "unreviewed."
 */
export function deriveMergeStepper(
  status: TaskStatus,
  prUrl: string | null,
  reviewDecision: ReviewDecision | null,
): MergeStepperState {
  if (!prUrl) return { kind: 'hidden' };
  if (status === 'failed') return { kind: 'failed' };

  if (status === 'awaiting_ci') {
    return {
      kind: 'steps',
      ci: 'active',
      review: 'upcoming',
      merge: 'upcoming',
      needsAttention: false,
    };
  }

  if (PAST_CI.has(status)) {
    const review: StepState = reviewDecision === 'approved' ? 'done' : 'active';
    return {
      kind: 'steps',
      ci: 'done',
      review: status === 'merged' ? 'done' : review,
      merge: status === 'merged' ? 'done' : status === 'merging' ? 'active' : 'upcoming',
      needsAttention: status === 'needs_human' || reviewDecision === 'changes_requested',
    };
  }

  // queued/dispatching/running/turn_ended/opening_pr/resolved/abandoned:
  // a PR shouldn't realistically exist yet (or the task is done/abandoned
  // via a path that doesn't need this display) — hide rather than guess.
  return { kind: 'hidden' };
}
