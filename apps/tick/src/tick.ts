import type { FastifyBaseLogger } from 'fastify';

import { runAiReview } from './ai-review';
import { runAutoMerge } from './auto-merge';
import { runBudgets } from './budgets';
import { runCiPoller } from './ci';
import { runDispatcher } from './dispatcher';
import { runGuardrails } from './guardrails';
import { runMemoryExpiry } from './memory';
import { runPoller } from './poller';
import { runReconciler } from './reconciler';
import { runVerify } from './verify';

export type TickResult = {
  durationMs: number;
  dispatcher: Awaited<ReturnType<typeof runDispatcher>>;
  poller: Awaited<ReturnType<typeof runPoller>>;
  guardrails: Awaited<ReturnType<typeof runGuardrails>>;
  ci: Awaited<ReturnType<typeof runCiPoller>>;
  verify: Awaited<ReturnType<typeof runVerify>>;
  autoMerge: Awaited<ReturnType<typeof runAutoMerge>>;
  budgets: Awaited<ReturnType<typeof runBudgets>>;
  aiReview: Awaited<ReturnType<typeof runAiReview>>;
  reconciler: Awaited<ReturnType<typeof runReconciler>>;
  memory: Awaited<ReturnType<typeof runMemoryExpiry>>;
};

/**
 * One tick, ordered:
 *   1. Poll events for every active Task — drives state transitions
 *      (queued → running → turn_ended → awaiting_ci) and maintains
 *      turnCount + no-progress markers.
 *   2. Guardrails — halt agent-active Tasks over a turn/token/no-progress cap,
 *      using the counts the poller just wrote.
 *   3. Poll GitHub Checks for awaiting_ci Tasks — advance to the next gate,
 *      failed, or trigger retry-with-feedback.
 *   4. Verify — self-verification gate: done-check against acceptance criteria.
 *   5. AI review gate.
 *   6. Auto-merge pass.
 *   7. Budgets — soft-pause at threshold, hard-stop (cancel in-flight) at ceiling.
 *   8. Reconcile: open late PRs, gate stall sweep, complete settled Missions.
 *   9. Dispatch queued Tasks on running Missions.
 *  10. Memory expiry.
 *
 * Two new steps insert into the existing order without reordering anything else.
 * Each step is wrapped so one failing subsystem doesn't silence the others.
 */
export async function runTick(log: FastifyBaseLogger): Promise<TickResult> {
  const started = Date.now();

  const poller = await runPoller(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:poller_crashed');
    return { tasksPolled: 0, eventsIngested: 0, transitions: 0, errors: 1 };
  });

  const guardrails = await runGuardrails(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:guardrails_crashed');
    return { tasksChecked: 0, halted: 0, byReason: {} };
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

  const verify = await runVerify(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:verify_crashed');
    return { tasksChecked: 0, passed: 0, retried: 0, escalated: 0, skipped: 0, errors: 1 };
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
    return { missionsChecked: 0, paused: 0, hardStopped: 0 };
  });

  const reconciler = await runReconciler(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:reconciler_crashed');
    return {
      missionsChecked: 0,
      missionsCompleted: 0,
      tasksAbandoned: 0,
      tasksCascadeFailed: 0,
      prsOpened: 0,
      gatesEscalated: 0,
    };
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
  return {
    durationMs,
    dispatcher,
    poller,
    guardrails,
    ci,
    verify,
    aiReview,
    autoMerge,
    budgets,
    reconciler,
    memory,
  };
}
