import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type TaskStatus } from '@forge/db';

import { getAdapter } from './adapters';
import { db } from './db';
import { INFLIGHT_STATUSES } from './dispatcher';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type BudgetResult = {
  missionsChecked: number;
  paused: number;
  hardStopped: number;
};

export const TOKEN_PRICE_USD_PER_1M = 5;

/**
 * Pure budget threshold check. Returns the max percentage crossed (token or
 * USD), or 0 if under threshold. Exported for unit testing.
 */
export function computeBudgetPct(opts: {
  spentTokens: number;
  budgetTokens: number | null;
  budgetUsd: number | null;
}): { tokenPct: number; usdPct: number; maxPct: number; spentUsd: number } {
  const spentUsd = (opts.spentTokens / 1_000_000) * TOKEN_PRICE_USD_PER_1M;
  const tokenPct =
    opts.budgetTokens && opts.budgetTokens > 0 ? (opts.spentTokens / opts.budgetTokens) * 100 : 0;
  const usdPct = opts.budgetUsd && opts.budgetUsd > 0 ? (spentUsd / opts.budgetUsd) * 100 : 0;
  return { tokenPct, usdPct, maxPct: Math.max(tokenPct, usdPct), spentUsd };
}

// Tasks contribute to budget while they're pre-terminal — once they're
// failed/abandoned/merged/awaiting_review/cancelled, no new spend accrues
// from them, but they DO count toward the running total. The total used
// here is "all cost ever spent on this Mission's Tasks", which matches
// what the operator expects: a budget is a total, not just a leak rate.
const ALL_TASK_STATUSES: TaskStatus[] = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
  'abandoned',
  'failed',
];

/**
 * A budgeted mission's spend family: itself plus its issue-leaf children.
 * Repo containers hold the budget but own zero tasks (the work lives on
 * leaves with `parentMissionId` set), so budget math must roll spend up
 * across the family — see mission-hierarchy design §"budgets".
 */
async function missionFamilyIds(missionId: string): Promise<string[]> {
  const children = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.parentMissionId, missionId));
  return [missionId, ...children.map((c) => c.id)];
}

/**
 * Auto-pause Missions that crossed their budget threshold.
 *
 * PRD §7.6: per-Mission budget in USD and/or tokens, threshold trigger
 * (default 80%) → Mission auto-pauses, Ledger event, operator notification.
 *
 * Phase 2 implementation: just the auto-pause + Ledger event. Notification
 * via webhook is a separate concern (PRD §14 Q4, deferred).
 *
 * Spent is computed live from sum(task.cost_tokens) across the mission's
 * family (itself + issue-leaf children) so we don't have to keep a
 * denormalised running total in sync.
 */
export async function runBudgets(log: Logger): Promise<BudgetResult> {
  // Both running AND paused Missions are evaluated: a Mission paused at the soft
  // threshold can still drift up to the hard ceiling as its in-flight Tasks land.
  const candidates = await db
    .select()
    .from(missions)
    .where(inArray(missions.status, ['running', 'paused']));

  let paused = 0;
  let hardStopped = 0;

  for (const mission of candidates) {
    const hasBudget =
      (mission.budgetUsd !== null && mission.budgetUsd > 0) ||
      (mission.budgetTokens !== null && mission.budgetTokens > 0);
    if (!hasBudget) continue;

    const familyIds = await missionFamilyIds(mission.id);
    const [agg] = await db
      .select({ tokens: sql<number>`coalesce(sum(${tasks.costTokens}), 0)` })
      .from(tasks)
      .where(and(inArray(tasks.missionId, familyIds), inArray(tasks.status, ALL_TASK_STATUSES)));

    const spentTokens = Number(agg?.tokens ?? 0);
    const { maxPct, spentUsd } = computeBudgetPct({
      spentTokens,
      budgetTokens: mission.budgetTokens,
      budgetUsd: mission.budgetUsd,
    });

    if (maxPct >= mission.budgetHardStopPct) {
      // Hard stop: cancel in-flight sessions, abandon queued, pause the Mission.
      if (await hardStop(mission, familyIds, spentTokens, spentUsd, maxPct, log)) hardStopped += 1;
      continue;
    }

    if (maxPct < mission.budgetThresholdPct) continue;

    // Soft pause only applies to running Missions (a paused one stays paused).
    if (mission.status !== 'running') continue;

    const now = new Date();
    const [updated] = await db
      .update(missions)
      .set({
        status: 'paused',
        spentUsd: Math.round(spentUsd),
        spentTokens,
        updatedAt: now,
      })
      .where(and(eq(missions.id, mission.id), eq(missions.status, 'running')))
      .returning();
    if (!updated) continue; // lost race; fine

    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'budget.auto_paused',
      payload: {
        spentTokens,
        spentUsd: Math.round(spentUsd * 100) / 100,
        budgetTokens: mission.budgetTokens,
        budgetUsd: mission.budgetUsd,
        thresholdPct: mission.budgetThresholdPct,
        crossedAtPct: Math.round(maxPct * 10) / 10,
      },
      createdAt: now,
    });
    paused += 1;
    log.info(
      { missionId: mission.id, spentTokens, thresholdPct: mission.budgetThresholdPct },
      'budgets:auto_paused',
    );
  }

  return { missionsChecked: candidates.length, paused, hardStopped };
}

/**
 * Hard-stop a Mission that crossed its `budgetHardStopPct` ceiling: pause the
 * Mission, actively cancel every in-flight session across its family (vs. the
 * soft pause, which lets in-flight Tasks finish), abandon queued Tasks, and
 * Ledger it. Pause — not cancel — because cancelled containers are excluded
 * from workspace-mission lookup, so cancelling would let the next "Work on it"
 * mint a fresh budget-less container and silently escape the stop; resuming
 * requires an explicit operator action (raise the budget / reactivate). The
 * mission UPDATE is guarded on the OBSERVED status (running or paused) so an
 * operator un-pausing mid-tick wins the race (spec §2). Idempotent: an
 * already-paused, already-drained family is a no-op (no repeat Ledger event).
 * Returns true if it acted.
 */
async function hardStop(
  mission: Mission,
  familyIds: string[],
  spentTokens: number,
  spentUsd: number,
  maxPct: number,
  log: Logger,
): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({
      status: 'paused',
      spentUsd: Math.round(spentUsd),
      spentTokens,
      updatedAt: now,
    })
    .where(and(eq(missions.id, mission.id), eq(missions.status, mission.status)))
    .returning();
  if (!updated) return false; // lost race (e.g. operator just resumed/cancelled)

  const inflight = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.missionId, familyIds),
        inArray(tasks.status, INFLIGHT_STATUSES),
        isNotNull(tasks.sessionId),
      ),
    );

  for (const task of inflight) {
    if (task.sessionId) {
      try {
        await getAdapter(mission.backend).cancelSession(task.sessionId);
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'budgets:hard_stop_cancel_failed',
        );
      }
    }
    await db
      .update(tasks)
      .set({
        status: 'failed',
        haltReason: 'budget_hard_stop',
        lastError: 'mission budget hard stop',
        updatedAt: now,
        completedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)));
  }

  const abandoned = await db
    .update(tasks)
    .set({
      status: 'abandoned',
      haltReason: 'budget_hard_stop',
      updatedAt: now,
      completedAt: now,
    })
    .where(and(inArray(tasks.missionId, familyIds), eq(tasks.status, 'queued')))
    .returning({ id: tasks.id });

  // Nothing actually stopped this tick (mission was already paused and the
  // family is drained) — don't Ledger the same hard stop every tick.
  const statusChanged = mission.status !== 'paused';
  if (!statusChanged && inflight.length === 0 && abandoned.length === 0) return false;

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'budget.hard_stopped',
    payload: {
      spentTokens,
      spentUsd: Math.round(spentUsd * 100) / 100,
      budgetTokens: mission.budgetTokens,
      budgetUsd: mission.budgetUsd,
      hardStopPct: mission.budgetHardStopPct,
      crossedAtPct: Math.round(maxPct * 10) / 10,
      sessionsCancelled: inflight.length,
    },
    createdAt: now,
  });
  log.info(
    {
      missionId: mission.id,
      spentTokens,
      hardStopPct: mission.budgetHardStopPct,
      sessionsCancelled: inflight.length,
    },
    'budgets:hard_stopped',
  );
  return true;
}
