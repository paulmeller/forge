import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type TaskStatus } from '@forge/db';

import { db } from './db';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type BudgetResult = {
  missionsChecked: number;
  paused: number;
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
    opts.budgetTokens && opts.budgetTokens > 0
      ? (opts.spentTokens / opts.budgetTokens) * 100
      : 0;
  const usdPct =
    opts.budgetUsd && opts.budgetUsd > 0
      ? (spentUsd / opts.budgetUsd) * 100
      : 0;
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
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
  'abandoned',
  'failed',
];

/**
 * Auto-pause Missions that crossed their budget threshold.
 *
 * PRD §7.6: per-Mission budget in USD and/or tokens, threshold trigger
 * (default 80%) → Mission auto-pauses, Ledger event, operator notification.
 *
 * Phase 2 implementation: just the auto-pause + Ledger event. Notification
 * via webhook is a separate concern (PRD §14 Q4, deferred).
 *
 * Spent is computed live from sum(task.cost_tokens) so we don't have to
 * keep a denormalised running total in sync.
 */
export async function runBudgets(log: Logger): Promise<BudgetResult> {
  const candidates = await db
    .select()
    .from(missions)
    .where(eq(missions.status, 'running'));

  let paused = 0;

  for (const mission of candidates) {
    const hasBudget =
      (mission.budgetUsd !== null && mission.budgetUsd > 0) ||
      (mission.budgetTokens !== null && mission.budgetTokens > 0);
    if (!hasBudget) continue;

    const [agg] = await db
      .select({ tokens: sql<number>`coalesce(sum(${tasks.costTokens}), 0)` })
      .from(tasks)
      .where(
        and(eq(tasks.missionId, mission.id), inArray(tasks.status, ALL_TASK_STATUSES)),
      );

    const spentTokens = Number(agg?.tokens ?? 0);
    const { maxPct, spentUsd } = computeBudgetPct({
      spentTokens,
      budgetTokens: mission.budgetTokens,
      budgetUsd: mission.budgetUsd,
    });

    if (maxPct < mission.budgetThresholdPct) continue;

    // Cross the threshold → transition running → paused.
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

  return { missionsChecked: candidates.length, paused };
}
