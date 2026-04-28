import type { FastifyBaseLogger } from 'fastify';

import { runAiReview } from './ai-review';
import { runAutoMerge } from './auto-merge';
import { runBudgets } from './budgets';
import { runCiPoller } from './ci';
import { runDispatcher } from './dispatcher';
import { runMemoryExpiry } from './memory';
import { runPoller } from './poller';
import { runReconciler } from './reconciler';

export type TickResult = {
  durationMs: number;
  dispatcher: Awaited<ReturnType<typeof runDispatcher>>;
  poller: Awaited<ReturnType<typeof runPoller>>;
  ci: Awaited<ReturnType<typeof runCiPoller>>;
  autoMerge: Awaited<ReturnType<typeof runAutoMerge>>;
  budgets: Awaited<ReturnType<typeof runBudgets>>;
  aiReview: Awaited<ReturnType<typeof runAiReview>>;
  reconciler: Awaited<ReturnType<typeof runReconciler>>;
  memory: Awaited<ReturnType<typeof runMemoryExpiry>>;
};

/**
 * One tick, ordered:
 *   1. Poll events for every active Task — drives state transitions
 *      (queued → running → turn_ended → awaiting_ci).
 *   2. Poll GitHub Checks for awaiting_ci Tasks — advance to awaiting_review,
 *      failed, or trigger retry-with-feedback.
 *   3. Auto-merge pass — for awaiting_review tasks whose Mission has an
 *      auto-merge policy that the diff satisfies, call pulls.merge.
 *   4. Budgets — auto-pause Missions that crossed their threshold.
 *   5. Reconcile: abandon stuck turn_ended Tasks with no PR, complete
 *      Missions whose Tasks have all settled.
 *   6. Dispatch queued Tasks on running Missions — uses inflight counts
 *      that reflect (1)–(5)'s transitions.
 *
 * Each step is wrapped so one failing subsystem doesn't silence the others.
 */
export async function runTick(log: FastifyBaseLogger): Promise<TickResult> {
  const started = Date.now();

  const poller = await runPoller(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:poller_crashed');
    return { tasksPolled: 0, eventsIngested: 0, transitions: 0, errors: 1 };
  });

  const ci = await runCiPoller(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:ci_crashed');
    return {
      tasksChecked: 0,
      transitionedToReview: 0,
      transitionedToFailed: 0,
      retried: 0,
      stillPending: 0,
    };
  });

  const aiReview = await runAiReview(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:ai_review_crashed');
    return { tasksChecked: 0, approved: 0, rejected: 0, escalated: 0, errors: 1 };
  });

  const autoMerge = await runAutoMerge(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:auto_merge_crashed');
    return { candidates: 0, merged: 0, blocked: 0, errors: 1 };
  });

  const budgets = await runBudgets(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:budgets_crashed');
    return { missionsChecked: 0, paused: 0 };
  });

  const reconciler = await runReconciler(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:reconciler_crashed');
    return { missionsChecked: 0, missionsCompleted: 0, tasksAbandoned: 0, tasksCascadeFailed: 0 };
  });

  const dispatcher = await runDispatcher(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:dispatcher_crashed');
    return { missions: 0, claimed: 0, dispatched: 0, failed: 1 };
  });

  const memory = await runMemoryExpiry(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:memory_crashed');
    return { expired: 0, reconfirmationNeeded: 0 };
  });

  const durationMs = Date.now() - started;
  return { durationMs, dispatcher, poller, ci, aiReview, autoMerge, budgets, reconciler, memory };
}
