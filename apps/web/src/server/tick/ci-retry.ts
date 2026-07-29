/**
 * What to do when CI has completed and failed on a Task's PR.
 *
 * The retry budget (TASK_RETRY_MAX) is meant to count *fix attempts*, but the
 * tick re-evaluates the same failing CI result every 60s. Gating only on
 * `retryCount < max` therefore re-sent the failure to the agent on every tick
 * and burned a 3-retry budget in ~90 seconds — the agent was interrupted with
 * a duplicate message each tick and never got long enough to push a fix, so
 * the SHA never changed and the same stale failure kept re-triggering.
 *
 * The head SHA is the honest signal that an attempt actually happened: it
 * changes only when the agent pushes. So a retry is sent once per SHA, not
 * once per tick.
 *
 * That alone would trade a storm for a wedge (an agent that never pushes would
 * sit in awaiting_ci forever — it is deliberately NOT in the reconciler's
 * GATE_STALL_STATUSES, because awaiting_ci legitimately waits on slow external
 * CI). The elapsed-time arm closes that: it only fires once a retry was really
 * dispatched for this exact SHA and nothing came back.
 */
export type CiRetryDecision = 'send' | 'wait' | 'escalate' | 'exhausted';

export function decideCiRetry(opts: {
  /** PR head SHA that CI failed on. */
  headSha: string;
  /** SHA of the most recent ci.retry_dispatched for this Task, if any. */
  lastRetrySha: string | null;
  /** When that retry was dispatched. */
  lastRetryAt: Date | null;
  retryCount: number;
  maxRetries: number;
  stallMs: number;
  now: Date;
}): CiRetryDecision {
  const alreadyRetriedThisSha = opts.lastRetrySha === opts.headSha;

  if (alreadyRetriedThisSha) {
    // The agent has the logs for exactly this SHA. Give it room to work; only
    // give up once nothing has been pushed for stallMs.
    const elapsed = opts.now.getTime() - (opts.lastRetryAt?.getTime() ?? 0);
    return elapsed >= opts.stallMs ? 'escalate' : 'wait';
  }

  // A SHA we have not retried yet — the agent pushed something new (or this is
  // the first failure). Spend a retry if the budget allows.
  return opts.retryCount < opts.maxRetries ? 'send' : 'exhausted';
}
