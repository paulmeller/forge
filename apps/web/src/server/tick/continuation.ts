/**
 * What to do with a task that ended its turn without pushing a branch.
 *
 * The agent finishing a turn (`end_turn`) is not the same as finishing the
 * work. Before this, the reconciler abandoned such a task at the first turn —
 * throwing away an agent that had simply not committed yet. Instead Forge
 * nudges it to finish, up to a bounded budget, then escalates to a human
 * rather than abandoning: work sitting in the sandbox is never dropped
 * silently.
 *
 * The decision here is pure. The reconciler owns the side effects (sending the
 * nudge, writing the ledger, moving the task) and the dead-session case: a
 * task in `turn_ended` has a live session by construction (the poller turns a
 * terminated session into `abandoned` before the reconciler runs), so a
 * failed nudge is the only way a session is discovered dead, and that is
 * handled operationally, not here.
 */
export type ContinuationDecision = 'continue' | 'escalate';

/**
 * @param nudgeCount  how many continuation nudges this task has already had
 * @param nudgeBudget env.TASK_CONTINUATION_MAX — 0 disables nudging entirely
 */
export function decideContinuation(nudgeCount: number, nudgeBudget: number): ContinuationDecision {
  return nudgeCount < nudgeBudget ? 'continue' : 'escalate';
}

export const CONTINUATION_PROMPT =
  'Your turn ended but no branch has been pushed for this task. If the work is ' +
  'complete, commit it and push a branch (open a pull request if you can). If it ' +
  'is not complete, continue where you left off.';
