import { randomUUID } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type AutoMergePolicy,
  type Mission,
  type TaskStatus,
} from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { getAdapter } from './adapters';
import { resolveAutoMergePolicy } from './auto-merge-policy';
import { branchIsTaskOwned, newestCommitDate } from './branch-ownership';
import { CONTINUATION_PROMPT, decideContinuation } from './continuation';
import { client as getOctokit, PR_URL_RE } from './auto-merge';
import { extractVerdictFromLedger } from './triage-verdict';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type ReconcileResult = {
  missionsChecked: number;
  missionsCompleted: number;
  tasksAbandoned: number;
  tasksContinued: number;
  tasksStalledEscalated: number;
  tasksCascadeFailed: number;
  prsOpened: number;
  gatesEscalated: number;
  reproduceResolved: number;
  fixesGated: number;
  mergesCompleted: number;
  mergesEscalated: number;
  mergeStallsEscalated: number;
};

export const DEPENDENCY_FAILED_STATUSES: TaskStatus[] = ['failed', 'abandoned'];

/**
 * Gate states a Task can wedge in if its validator persistently errors. They are
 * driven by the verify / ai-review subsystems (not by backend events), so a
 * validator that keeps failing never advances the Task and never increments its
 * retry counter. The stall sweep escalates such a Task to `needs_human` so it
 * can't hold a concurrency slot or block Mission completion forever (spec §3.2).
 */
const GATE_STALL_STATUSES: TaskStatus[] = ['awaiting_verify', 'awaiting_ai_review'];

/**
 * Merge-side states a Task can wedge in forever with no other exit:
 *  - `ready_to_merge` when every candidate hand-off to `runAutoMerge`
 *    (auto-merge.ts) keeps erroring (its outer catch just logs and
 *    increments a counter, never moving the Task) or keeps getting
 *    `markBlocked` (which only ever touches `lastError`, never `status`).
 *  - `merging` when the merging sweep's `pulls.get` call keeps failing
 *    (revoked token, renamed/deleted repo, ...) — that catch path logs and
 *    continues with no attempt counter and no escalation.
 * The stall sweep below (step 1.8) is the one mechanism that rescues both:
 * age past MERGE_STALL_MS, on `updatedAt`, means genuinely stuck, not just
 * "still legitimately waiting" (see that sweep's comment for why neither
 * status's no-op paths bump `updatedAt`, which is what makes this safe).
 */
const MERGE_STALL_STATUSES: TaskStatus[] = ['ready_to_merge', 'merging'];

/**
 * Post-turn states a `reproduce` Task may be found in when the reconciler settles
 * it to a verdict. Normally just `turn_ended`; the PR-gate states are a defensive
 * belt in case a reproduce agent opened a PR despite its narrowed toolset.
 */
const REPRODUCE_SETTLE_STATUSES: TaskStatus[] = [
  'turn_ended',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
];

// `ready_to_merge` is deliberately absent from this bare list: whether it
// counts as terminal depends on the owning Mission's auto-merge policy — see
// `missionTerminalStatusesFor` below, which is what step (2) actually
// queries against. `needs_human` stays terminal — the Mission has done
// everything it can without a person.
export const MISSION_TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'merged',
  'resolved',
  'needs_human',
  'abandoned',
  'failed',
];

/**
 * The terminal-status set for one Mission's completion check, conditional
 * on whether anything will actually act on a `ready_to_merge` Task:
 *
 *  - No enabled auto-merge policy: nothing but a human clicking merge on
 *    GitHub directly will ever move this Task again — exactly the same
 *    situation as `needs_human` — so it must not hold the Mission open
 *    forever (C1: before this, `ready_to_merge` was mission-terminal, and
 *    the branch regressed that).
 *  - An enabled policy: `runAutoMerge` (and, once armed, the merging sweep)
 *    are expected to resolve this Task soon. Keep the Mission open until
 *    they do, or it could complete out from under an in-flight merge.
 *
 * Takes an already-resolved policy rather than a Mission row: an issue-leaf
 * Mission's own `autoMergePolicy` column is never the answer (repo settings
 * only ever update the container row) — resolution through the container
 * happens once at the caller via `resolveAutoMergePolicy`, so this stays a
 * pure, synchronous mapping that's directly unit-testable.
 */
export function missionTerminalStatusesFor(policy: AutoMergePolicy | null): TaskStatus[] {
  if (policy?.enabled) return MISSION_TERMINAL_TASK_STATUSES;
  return [...MISSION_TERMINAL_TASK_STATUSES, 'ready_to_merge'];
}

/**
 * Close out Missions whose Tasks have all settled, and clean up Tasks that
 * stalled in turn_ended with no PR (agent produced no diff — PRD §7.5).
 *
 * Called by the tick after the poller so fresh state transitions from this
 * tick feed into the completion check.
 */
export async function runReconciler(log: Logger): Promise<ReconcileResult> {
  let tasksAbandoned = 0;
  let tasksContinued = 0;
  let tasksStalledEscalated = 0;
  let missionsCompleted = 0;

  // (0) Cascade-fail queued tasks whose dependencies have failed/abandoned.
  let tasksCascadeFailed = 0;
  const blocked = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'queued'), isNotNull(tasks.dependsOnIds)));

  for (const task of blocked) {
    const depIds = (task.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) continue;

    const [failedDeps] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(inArray(tasks.id, depIds), inArray(tasks.status, DEPENDENCY_FAILED_STATUSES)));

    if (Number(failedDeps?.count ?? 0) > 0) {
      const now = new Date();
      await db
        .update(tasks)
        .set({
          status: 'failed',
          lastError: 'upstream dependency failed',
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'queued')));
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.dependency_failed',
        payload: { dependsOnIds: depIds },
        createdAt: now,
      });
      tasksCascadeFailed += 1;
      log.info({ taskId: task.id }, 'reconciler:dependency_failed');
    }
  }

  // (0b) Settle `reproduce` Tasks that have finished their turn. They open no
  // PR — they emit a verdict. Lift the parsed verdict onto the Task and mark it
  // `resolved`; if the agent produced no parseable verdict, abandon it. Runs
  // before the fix gate (0c) so a negative verdict is acted on the same tick,
  // and before the generic turn_ended→open-PR sweep (step 1) so reproduce Tasks
  // are never mistaken for "agent pushed a branch but opened no PR".
  let reproduceResolved = 0;
  // A reproduce Task should only ever sit in `turn_ended` (it opens no PR), but
  // narrow the toolset can't be fully trusted — if one wandered into a PR-gate
  // state, settle it by verdict anyway rather than let it ride the CI/merge path.
  const finishedRepro = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, REPRODUCE_SETTLE_STATUSES), eq(tasks.kind, 'reproduce')));

  for (const task of finishedRepro) {
    const evs = await db
      .select({ eventType: ledgerEvents.eventType, payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(eq(ledgerEvents.taskId, task.id))
      .orderBy(ledgerEvents.createdAt);
    const verdict = extractVerdictFromLedger(evs);
    const now = new Date();

    if (verdict) {
      const [updated] = await db
        .update(tasks)
        .set({ status: 'resolved', verdict, updatedAt: now, completedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
        .returning();
      if (!updated) continue;
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'triage.reproduced',
        payload: {
          reproduced: verdict.reproduced,
          summary: verdict.summary,
          affectedVersions: verdict.affectedVersions ?? null,
        },
        createdAt: now,
      });
      reproduceResolved += 1;
      log.info({ taskId: task.id, reproduced: verdict.reproduced }, 'reconciler:reproduce_resolved');
    } else {
      const [updated] = await db
        .update(tasks)
        .set({
          status: 'abandoned',
          lastError: 'reproduce agent emitted no verdict',
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
        .returning();
      if (!updated) continue;
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.abandoned',
        payload: { reason: 'reproduce turn ended with no forge-verdict block' },
        createdAt: now,
      });
      tasksAbandoned += 1;
      log.info({ taskId: task.id }, 'reconciler:reproduce_no_verdict');
    }
  }

  // (0c) Triage gate: abandon queued `fix` Tasks whose `reproduce` dependency
  // resolved with a negative verdict. The bug didn't reproduce on the tested
  // versions, so there's nothing to fix — don't spend a fix session on it.
  // (A positive verdict leaves the fix `queued`; the dispatcher then unblocks
  // it. A failed/abandoned reproduce is handled by the cascade in step 0.)
  let fixesGated = 0;
  const pendingFixes = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'queued'), eq(tasks.kind, 'fix'), isNotNull(tasks.dependsOnIds)));

  for (const fix of pendingFixes) {
    const depIds = (fix.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) continue;
    const deps = await db.select().from(tasks).where(inArray(tasks.id, depIds));
    const negative = deps.some(
      (d) => d.kind === 'reproduce' && d.status === 'resolved' && d.verdict?.reproduced === false,
    );
    if (!negative) continue;

    const now = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'abandoned',
        lastError: 'bug did not reproduce',
        updatedAt: now,
        completedAt: now,
      })
      .where(and(eq(tasks.id, fix.id), eq(tasks.status, 'queued')))
      .returning();
    if (!updated) continue;
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: fix.missionId,
      taskId: fix.id,
      eventType: 'triage.fix_skipped',
      payload: { reason: 'reproduce verdict was negative', dependsOnIds: depIds },
      createdAt: now,
    });
    fixesGated += 1;
    log.info({ taskId: fix.id }, 'reconciler:fix_skipped_not_reproduced');
  }

  // (1) turn_ended with no PR → try to open a PR via Octokit.
  // The agent pushed a branch but didn't open a PR (common with Codex/OpenCode
  // which don't have MCP tools). Forge opens the PR on their behalf.
  // If no branch was pushed, abandon the task.
  let prsOpened = 0;
  const stalled = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'turn_ended'), isNull(tasks.prUrl)));

  for (const task of stalled) {
    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, task.missionId))
      .limit(1);
    if (!mission) continue;

    const opened = await tryOpenPr(task, mission, log);
    if (opened) {
      prsOpened += 1;
      continue;
    }

    // No branch was produced. The agent ending its turn is not the work being
    // done, so nudge it to finish rather than abandon at the first turn. The
    // nudge is bounded (env.TASK_CONTINUATION_MAX); once spent, escalate to a
    // human so sandbox work is never dropped silently. A `reproduce` task
    // pushes no branch by design and is settled earlier (step 0b) — guarded
    // here too. A task without a session cannot be continued.
    const now = new Date();
    const [seen] = await db
      .select({ n: sql<number>`count(*)` })
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.taskId, task.id), eq(ledgerEvents.eventType, 'task.continued')));
    const nudgeCount = Number(seen?.n ?? 0);
    const canContinue = task.kind !== 'reproduce' && Boolean(task.sessionId);

    if (canContinue && decideContinuation(nudgeCount, env.TASK_CONTINUATION_MAX) === 'continue') {
      // Claim the task with a compare-and-swap BEFORE the nudge, exactly like
      // every other CAS in this file — the nudge is a non-idempotent call to
      // the agent's session, so two overlapping reconciler passes must not
      // both fire it. Only the pass that flips turn_ended→running proceeds.
      const [claimed] = await db
        .update(tasks)
        .set({ status: 'running', updatedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')))
        .returning({ id: tasks.id });
      if (!claimed) continue; // lost the race — the other pass owns it

      try {
        await getAdapter(mission.backend).sendTurn({
          sessionId: task.sessionId!,
          text: CONTINUATION_PROMPT,
        });
      } catch (err) {
        // The session is gone (a poller race we lost). We already own the row
        // (status is now 'running'), so settle it as abandoned rather than
        // leaving it wedged.
        log.info({ taskId: task.id, err }, 'reconciler:continue_failed_session_gone');
        const settleAt = new Date();
        await db
          .update(tasks)
          .set({ status: 'abandoned', updatedAt: settleAt, completedAt: settleAt })
          .where(eq(tasks.id, task.id));
        await db.insert(ledgerEvents).values({
          id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          missionId: task.missionId,
          taskId: task.id,
          eventType: 'task.abandoned',
          payload: { reason: 'continuation failed — session gone' },
          createdAt: settleAt,
        });
        tasksAbandoned += 1;
        continue;
      }

      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.continued',
        payload: { nudge: nudgeCount + 1, reason: 'turn_ended with no branch' },
        createdAt: now,
      });
      tasksContinued += 1;
      log.info({ taskId: task.id, nudge: nudgeCount + 1 }, 'reconciler:task_continued');
      continue;
    }

    if (canContinue) {
      // Budget spent and still no branch: hand it to a human with the reason,
      // never a silent abandon. Claim first so a racing pass can't also act.
      const [claimed] = await db
        .update(tasks)
        .set({
          status: 'needs_human',
          escalationReason: 'stalled_no_branch',
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')))
        .returning({ id: tasks.id });
      if (!claimed) continue;

      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'gate.escalated',
        payload: { reason: 'stalled_no_branch', nudges: nudgeCount },
        createdAt: now,
      });
      tasksStalledEscalated += 1;
      log.info({ taskId: task.id, nudges: nudgeCount }, 'reconciler:task_stalled_escalated');
      continue;
    }

    // Reproduce task that wandered here, or a task with no session to continue
    // → abandon (the original behaviour). Claim first, same as above.
    const [claimed] = await db
      .update(tasks)
      .set({ status: 'abandoned', updatedAt: now, completedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')))
      .returning({ id: tasks.id });
    if (!claimed) continue;
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.abandoned',
      payload: { reason: 'turn_ended with no PR and no branch found' },
      createdAt: now,
    });
    tasksAbandoned += 1;
    log.info({ taskId: task.id }, 'reconciler:task_abandoned');
  }

  // (1.5) Gate stall sweep: escalate Tasks wedged in a gate state past
  // GATE_STALL_MS (validator persistently erroring) to needs_human.
  let gatesEscalated = 0;
  const staleCutoff = new Date(Date.now() - env.GATE_STALL_MS);
  const stalledGates = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, GATE_STALL_STATUSES), lt(tasks.updatedAt, staleCutoff)));

  for (const task of stalledGates) {
    const now = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'needs_human',
        escalationReason: 'gate_stall',
        // Re-escalating to a human: any earlier approval was for a diff that
        // never got this far. Don't let it survive to cover whatever comes
        // out of this stall.
        approvedBy: null,
        lastError: `gate stalled in ${task.status} for >${env.GATE_STALL_MS}ms`,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) continue;
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'gate.stalled',
      payload: { from: task.status, stalledMs: env.GATE_STALL_MS },
      createdAt: now,
    });
    gatesEscalated += 1;
    log.info({ taskId: task.id, from: task.status }, 'reconciler:gate_stalled');
  }

  // (1.7) Merging sweep: reconcile Tasks GitHub's native auto-merge left
  // armed. `tryMerge` (auto-merge.ts) only ARMS a merge via the
  // `enablePullRequestAutoMerge` GraphQL mutation and leaves the Task in
  // `merging` — GitHub decides when (and whether) the PR actually merges,
  // once its required checks resolve. Nothing else moves the Task on: the
  // Forge GitHub App is not subscribed to the `pull_request` webhook event,
  // and even once a handler for it exists (a later task), that only ever
  // fires if a human ticks the event subscription in the GitHub App
  // settings UI — so it must stay a fast path, never the only path. This
  // sweep is the real path: every tick, ask GitHub directly what happened.
  let mergesCompleted = 0;
  let mergesEscalated = 0;
  const armed = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'merging'), isNotNull(tasks.prUrl)));

  for (const task of armed) {
    const match = task.prUrl ? PR_URL_RE.exec(task.prUrl) : null;
    if (!match) continue;
    const [, owner, repo, pullStr] = match;
    if (!owner || !repo || !pullStr) continue;
    const pullNumber = Number(pullStr);

    let pr: { state?: string; merged?: boolean } | undefined;
    try {
      const { data } = await getOctokit().pulls.get({ owner, repo, pull_number: pullNumber });
      pr = data;
    } catch (err) {
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'reconciler:merge_sweep_check_failed',
      );
      continue; // couldn't get a real answer — leave it for next tick
    }

    if (pr.merged) {
      const now = new Date();
      // Guard on the status we selected: if a concurrent transition already
      // moved this Task on, don't clobber it.
      const [updated] = await db
        .update(tasks)
        .set({
          status: 'merged',
          completedAt: now,
          updatedAt: now,
          // Believed inert today (nothing currently reads approvedBy off a
          // merged Task), but every other exit from `merging`/`ready_to_merge`
          // clears it — leaving it set here is the one path the invariant
          // scan never actually drives a row through, so it's the one place
          // that gap would go unnoticed if something later started trusting
          // approvedBy past a merge.
          approvedBy: null,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'merging')))
        .returning();
      if (!updated) continue;
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'auto_merge.merged',
        payload: { prNumber: pullNumber },
        createdAt: now,
      });
      mergesCompleted += 1;
      log.info({ taskId: task.id, prNumber: pullNumber }, 'reconciler:merge_completed');
      continue;
    }

    if (pr.state === 'closed') {
      // Closed without merging: either a human closed the PR, or the armed
      // auto-merge got disarmed (branch protection changed, a required
      // check failed permanently, someone clicked "Disable auto-merge",
      // ...). Either way a person needs to look — don't keep polling.
      const now = new Date();
      const [updated] = await db
        .update(tasks)
        .set({
          status: 'needs_human',
          escalationReason: 'auto_merge_failed',
          // The earlier approval was for a PR that just closed unmerged —
          // it does not cover whatever a human decides to do next.
          approvedBy: null,
          lastError:
            'PR closed without merging while auto-merge was armed — a human closed it, or auto-merge was disarmed',
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'merging')))
        .returning();
      if (!updated) continue;
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'auto_merge.failed',
        payload: { prNumber: pullNumber, reason: 'pr_closed_unmerged' },
        createdAt: now,
      });
      mergesEscalated += 1;
      log.info({ taskId: task.id, prNumber: pullNumber }, 'reconciler:merge_escalated');
      continue;
    }

    // PR still open — legitimately waiting on required checks. Leave it alone.
  }

  // (1.8) Merge-stall sweep: escalate Tasks wedged in `ready_to_merge` or
  // `merging` past MERGE_STALL_MS to needs_human. See MERGE_STALL_STATUSES
  // above for why both need this: `ready_to_merge` because `runAutoMerge`
  // never moves a persistently-erroring or persistently-blocked candidate
  // off that status, and `merging` because the sweep just above leaves a
  // Task exactly where it found it whenever `pulls.get` keeps failing or the
  // PR is genuinely still open — neither of those no-op paths bumps
  // `updatedAt`, so age here reflects real elapsed time in the status, not
  // how many times this sweep has looked at it.
  let mergeStallsEscalated = 0;
  const mergeStaleCutoff = new Date(Date.now() - env.MERGE_STALL_MS);
  const stalledMerges = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, MERGE_STALL_STATUSES), lt(tasks.updatedAt, mergeStaleCutoff)));

  for (const task of stalledMerges) {
    const now = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'needs_human',
        escalationReason: 'merge_stall',
        // Re-escalating to a human: whatever approval or armed-merge state
        // got this Task here does not cover whatever a human decides to do
        // about a Task that's been stuck this long.
        approvedBy: null,
        lastError: `merge stalled in ${task.status} for >${env.MERGE_STALL_MS}ms`,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) continue;
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'merge.stalled',
      payload: { from: task.status, stalledMs: env.MERGE_STALL_MS },
      createdAt: now,
    });
    mergeStallsEscalated += 1;
    log.info({ taskId: task.id, from: task.status }, 'reconciler:merge_stalled');
  }

  // (2) Complete Missions whose tasks are all in terminal states. A repo's
  // container Mission (workspaceRepo set, issueRef null, parentMissionId
  // null) is fed by neither a planner nor "Work on it" directly — it owns
  // zero tasks by construction, so the existing "zero tasks, leave alone"
  // guard below already protects it without needing its own predicate.
  // Issue leaf missions and campaigns are both eligible here.
  const candidates = await db
    .select()
    .from(missions)
    .where(eq(missions.status, 'running'));

  // M2: unlike auto-merge.ts's identical-looking cache (several ready_to_merge
  // Tasks there commonly share one Mission, so memoizing by missionId is a
  // real hit), `candidates` here comes straight from `SELECT * FROM missions`
  // — every row is a distinct Mission by construction (missions.id is the
  // primary key), so a cache keyed on `mission.id` in the loop below can
  // never hit; it was always exactly one lookup, one cache miss, one store,
  // per Mission. Call the live resolver directly rather than keep a cache
  // that reads as an optimization but isn't one.
  for (const mission of candidates) {
    const policy = await resolveAutoMergePolicy(mission.id);
    const terminal = missionTerminalStatusesFor(policy);
    const nonTerminal = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.missionId, mission.id), notInArray(tasks.status, terminal)));
    const remaining = Number(nonTerminal[0]?.count ?? 0);
    if (remaining > 0) continue;

    const anyTasks = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.missionId, mission.id));
    if (Number(anyTasks[0]?.count ?? 0) === 0) continue; // Mission with zero tasks — leave alone

    await completeMission(mission);
    missionsCompleted += 1;
    log.info({ missionId: mission.id }, 'reconciler:mission_completed');
  }

  return {
    missionsChecked: candidates.length,
    missionsCompleted,
    tasksAbandoned,
    tasksContinued,
    tasksStalledEscalated,
    tasksCascadeFailed,
    prsOpened,
    gatesEscalated,
    reproduceResolved,
    fixesGated,
    mergesCompleted,
    mergesEscalated,
    mergeStallsEscalated,
  };
}

let octokit: Octokit | undefined;
function gh(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) throw new Error('GITHUB_APP_TOKEN not configured');
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

/**
 * After an agent pushes a branch but doesn't open a PR, Forge opens one.
 * Looks for branches matching common patterns (forge/*, feat/issue-*).
 * Returns true if a PR was opened, false if no branch found.
 */
async function tryOpenPr(
  task: typeof tasks.$inferSelect,
  mission: typeof missions.$inferSelect,
  log: Logger,
): Promise<boolean> {
  const [owner, repo] = task.repo.split('/');
  if (!owner || !repo) return false;

  try {
    // Look for branches the agent might have pushed
    const candidates = [
      `forge/${task.id}`,
      `feat/issue-${task.issueRef?.split('#')[1] ?? ''}`,
      `forge/fix-${task.id.slice(4, 12)}`,
    ].filter((b) => b && !b.endsWith('-') && !b.endsWith('/'));

    // Discover branches the agent actually pushed. It names its own branch
    // (Claude Code pushes `claude/<slug>`), so the candidates above rarely
    // match — discovery is required. Adoption is gated by branchIsTaskOwned
    // below: a discovered branch is only this task's if its head commit is
    // newer than the task's dispatch. Without that gate, a task that pushed
    // nothing adopted a six-week-old branch merely ahead of main.
    const { data: branches } = await gh().repos.listBranches({ owner, repo, per_page: 30 });
    const defaultBranch = task.baseBranch || 'main';
    const discovered = branches.filter((b) => b.name !== defaultBranch).map((b) => b.name);

    // Task-derived names first (owned by construction), then discovered names.
    const allCandidates = [...new Set([...candidates, ...discovered])];

    for (const branch of allCandidates) {
      try {
        // Check if this branch has commits ahead of the default branch
        const { data: comparison } = await gh().repos.compareCommits({
          owner,
          repo,
          base: defaultBranch,
          head: branch,
        });
        if (comparison.ahead_by === 0) continue;

        // Provenance gate: only open a PR from a branch this task produced.
        // A task-derived name is trusted; any discovered branch must have been
        // pushed after the task was dispatched, or it is a stranger and we
        // leave the task for the stall sweep rather than attribute someone
        // else's work to it.
        if (!branchIsTaskOwned(branch, candidates, newestCommitDate(comparison.commits), task.dispatchedAt)) {
          log.info(
            { taskId: task.id, branch, dispatchedAt: task.dispatchedAt },
            'reconciler:branch_not_task_owned_skipped',
          );
          continue;
        }

        // Check if a PR already exists for this branch
        const { data: existingPrs } = await gh().pulls.list({
          owner,
          repo,
          head: `${owner}:${branch}`,
          state: 'open',
        });
        if (existingPrs.length > 0) {
          // PR already exists — just record it
          const pr = existingPrs[0]!;
          const now = new Date();
          await db
            .update(tasks)
            .set({
              status: 'awaiting_ci',
              prUrl: pr.html_url,
              prNumber: pr.number,
              diffAdditions: comparison.total_commits,
              updatedAt: now,
            })
            .where(eq(tasks.id, task.id));
          log.info({ taskId: task.id, prNumber: pr.number }, 'reconciler:existing_pr_found');
          return true;
        }

        // Derive PR title from the linked issue (if any) or the mission name
        let title = `Forge: ${mission.name}`;
        if (task.issueRef) {
          const issueNum = task.issueRef.split('#')[1];
          if (issueNum) {
            try {
              const { data: issue } = await gh().issues.get({
                owner,
                repo,
                issue_number: Number(issueNum),
              });
              title = issue.title;
            } catch {
              /* fall back to mission name */
            }
          }
        } else if (mission.name.startsWith('GH:')) {
          title = mission.name.replace(/^GH:\s*\S+\s*—\s*/, '');
        }

        const { data: pr } = await gh().pulls.create({
          owner,
          repo,
          title,
          body: `Automated by Forge.\n\nMission: ${mission.name}\nTask: ${task.id}\nBranch: ${branch}`,
          head: branch,
          base: defaultBranch,
        });

        const now = new Date();
        await db
          .update(tasks)
          .set({
            status: 'awaiting_ci',
            prUrl: pr.html_url,
            prNumber: pr.number,
            diffAdditions: comparison.files?.length ?? 0,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id));

        await db.insert(ledgerEvents).values({
          id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          missionId: mission.id,
          taskId: task.id,
          eventType: 'gate.pr_opened',
          payload: {
            prNumber: pr.number,
            prUrl: pr.html_url,
            branch,
            aheadBy: comparison.ahead_by,
            openedBy: 'forge-reconciler',
          },
          createdAt: now,
        });

        log.info({ taskId: task.id, prNumber: pr.number, branch }, 'reconciler:pr_opened');
        return true;
      } catch {
        // Branch doesn't exist or comparison failed — try next
        continue;
      }
    }
  } catch (err) {
    log.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'reconciler:pr_open_failed',
    );
  }
  return false;
}

async function completeMission(mission: Mission): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(missions.id, mission.id), eq(missions.status, 'running')))
    .returning();
  if (!updated) return; // lost the race; fine

  const [counts] = await db
    .select({
      merged: sql<number>`sum(case when ${tasks.status} = 'merged' then 1 else 0 end)`,
      needsHuman: sql<number>`sum(case when ${tasks.status} = 'needs_human' then 1 else 0 end)`,
      abandoned: sql<number>`sum(case when ${tasks.status} = 'abandoned' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${tasks.status} = 'failed' then 1 else 0 end)`,
    })
    .from(tasks)
    .where(eq(tasks.missionId, mission.id));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'mission.completed',
    payload: {
      merged: Number(counts?.merged ?? 0),
      needsHuman: Number(counts?.needsHuman ?? 0),
      abandoned: Number(counts?.abandoned ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    createdAt: now,
  });
}
