export type GateStatus = 'awaiting_verify' | 'awaiting_ai_review' | 'ready_to_merge';

/**
 * Which gate a Task advances to *after* the self-verify gate — or after CI when
 * self-verify is off. Shared by `ci.ts` and `verify.ts` so the two can't drift.
 *
 * The clean path ends at `ready_to_merge`, never `needs_human`: reaching here
 * means every enabled gate passed. Escalations route to `needs_human` at their
 * own call sites, which also set an escalation reason.
 */
export function afterVerifyStatus(
  aiReviewEnabled: boolean,
): 'awaiting_ai_review' | 'ready_to_merge' {
  return aiReviewEnabled ? 'awaiting_ai_review' : 'ready_to_merge';
}

/**
 * Which status a green CI build routes to. Self-verify (when enabled and the
 * Task has acceptance criteria) runs first; otherwise it's the same choice as
 * `afterVerifyStatus`.
 */
export function postCiStatus(opts: {
  selfVerifyEnabled: boolean;
  hasAcceptanceCriteria: boolean;
  aiReviewEnabled: boolean;
}): GateStatus {
  if (opts.selfVerifyEnabled && opts.hasAcceptanceCriteria) return 'awaiting_verify';
  return afterVerifyStatus(opts.aiReviewEnabled);
}
