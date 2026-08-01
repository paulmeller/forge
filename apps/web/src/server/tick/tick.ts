import { runAiReview } from './ai-review';
import { runAutoMerge } from './auto-merge';
import { runBudgets } from './budgets';
import { runCiPoller } from './ci';
import { runDeviceCodeSweep } from './device-codes';
import { runDispatcher } from './dispatcher';
import { runGuardrails } from './guardrails';
import { runMemoryExpiry } from './memory';
import { runOnboarding } from './onboarding';
import { runPoller } from './poller';
import { runReconciler } from './reconciler';
import { runVerify } from './verify';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

export type TickResult = {
  durationMs: number;
  dispatcher: Awaited<ReturnType<typeof runDispatcher>>;
  poller: Awaited<ReturnType<typeof runPoller>>;
  onboarding: Awaited<ReturnType<typeof runOnboarding>>;
  guardrails: Awaited<ReturnType<typeof runGuardrails>>;
  ci: Awaited<ReturnType<typeof runCiPoller>>;
  verify: Awaited<ReturnType<typeof runVerify>>;
  autoMerge: Awaited<ReturnType<typeof runAutoMerge>>;
  budgets: Awaited<ReturnType<typeof runBudgets>>;
  aiReview: Awaited<ReturnType<typeof runAiReview>>;
  reconciler: Awaited<ReturnType<typeof runReconciler>>;
  memory: Awaited<ReturnType<typeof runMemoryExpiry>>;
  deviceCodes: Awaited<ReturnType<typeof runDeviceCodeSweep>>;
};

/**
 * One tick, ordered:
 *   1. Poll events for every active Task — drives state transitions
 *      (queued → running → turn_ended → awaiting_ci) and maintains
 *      turnCount + no-progress markers.
 *   2. Onboarding gate (#40) — propose `.forge/policy.yml` for a newly
 *      connected repo, flip it to active once merged, re-gate on deletion.
 *      Runs before the dispatcher below so a repo activated this tick can
 *      dispatch this same tick rather than waiting one tick behind.
 *   3. Guardrails — halt agent-active Tasks over a turn/token/no-progress cap,
 *      using the counts the poller just wrote.
 *   4. Poll GitHub Checks for awaiting_ci Tasks — advance to the next gate,
 *      failed, or trigger retry-with-feedback.
 *   5. Verify — self-verification gate: done-check against acceptance criteria.
 *   6. AI review gate.
 *   7. Auto-merge pass.
 *   8. Budgets — soft-pause at threshold, hard-stop (cancel in-flight) at ceiling.
 *   9. Reconcile: open late PRs, gate stall sweep, complete settled Missions.
 *  10. Dispatch queued Tasks on running Missions.
 *  11. Memory expiry.
 *  12. Device-code expiry sweep.
 *
 * Two new steps insert into the existing order without reordering anything else.
 * Each step is wrapped so one failing subsystem doesn't silence the others.
 */
export async function runTick(log: Logger): Promise<TickResult> {
  const started = Date.now();

  const poller = await runPoller(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:poller_crashed');
    return { tasksPolled: 0, eventsIngested: 0, transitions: 0, errors: 1 };
  });

  const onboarding = await runOnboarding(log).catch((err) => {
    log.warn({ err: String(err) }, 'tick:onboarding_failed');
    return { reposChecked: 0, prsOpened: 0, activated: 0, regated: 0 };
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

  // M3: auto-merge MUST run before the reconciler, and this is pinned by
  // tick.test.ts's call-order test — do not reorder these two without
  // reading this comment.
  //
  // Both auto-merge.ts and reconciler.ts each resolve
  // `resolveAutoMergePolicy(missionId)` through their own per-invocation
  // Map cache (auto-merge.ts's is a real optimization — several
  // ready_to_merge Tasks commonly share one Mission; reconciler.ts's
  // equivalent was removed as dead code, M2, since its candidates are
  // always distinct Missions). Running auto-merge first means that within
  // this SAME tick:
  //  - Any ready_to_merge Task auto-merge arms this tick moves to `merging`
  //    before the reconciler's merging sweep (step 1.7) runs, so a PR that
  //    GitHub already merged synchronously can be observed and the Task
  //    settled to `merged` in the SAME tick, instead of sitting one whole
  //    tick behind for no reason.
  //  - The reconciler's mission-completion check (step 2,
  //    `missionTerminalStatusesFor`) sees the Task status auto-merge just
  //    produced this tick (`merging`/`merged`/`needs_human`), not the
  //    Task's pre-auto-merge status — so a Mission whose only Task just got
  //    armed or merged this tick is evaluated against current reality, not
  //    reality as of the previous tick.
  // Reversing the order doesn't corrupt data (each function reads
  // `missions`/`tasks` fresh, live, every tick — nothing here is ACTUALLY a
  // stale-cache bug), but it does silently reintroduce a full tick of
  // latency on both of the above, and future changes to either module's
  // caching could turn that latency gap into a real staleness bug. Pin the
  // order so that risk can't grow unnoticed.
  const reconciler = await runReconciler(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:reconciler_crashed');
    return {
      missionsChecked: 0,
      missionsCompleted: 0,
      tasksAbandoned: 0,
      tasksContinued: 0,
      tasksStalledEscalated: 0,
      tasksCascadeFailed: 0,
      prsOpened: 0,
      gatesEscalated: 0,
      reproduceResolved: 0,
      fixesGated: 0,
      mergesCompleted: 0,
      mergesEscalated: 0,
      mergeStallsEscalated: 0,
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

  // Ordering-independent: it only deletes rows nothing can still use, and no
  // other step reads `deviceCode`. It sits last with the other expiry sweep
  // so the ordering constraints above stay confined to steps 1–9.
  const deviceCodes = await runDeviceCodeSweep(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:device_codes_crashed');
    return { deleted: 0 };
  });

  const durationMs = Date.now() - started;
  return {
    durationMs,
    dispatcher,
    poller,
    onboarding,
    guardrails,
    ci,
    verify,
    aiReview,
    autoMerge,
    budgets,
    reconciler,
    memory,
    deviceCodes,
  };
}
