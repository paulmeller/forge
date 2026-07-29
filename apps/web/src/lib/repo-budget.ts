import { and, eq, sql } from 'drizzle-orm';

import { missions, tasks, type Mission } from '@forge/db';

import { db } from './db';
import { tokensToUsd } from './token-pricing';

export type RepoBudget = { spentUsd: number; capUsd: number | null; pct: number | null };

/**
 * Roll a repo's missions up into one budget line. Spend is summed across
 * every mission (containers hold no tasks so their spend is 0; issue leaves
 * accrue it). The cap comes from the container — the pure envelope with no
 * issueRef and no parent.
 */
export function computeRepoBudget(
  rows: Array<Pick<Mission, 'spentUsd' | 'budgetUsd' | 'issueRef' | 'parentMissionId'>>,
): RepoBudget {
  const spentUsd = rows.reduce((sum, r) => sum + (r.spentUsd ?? 0), 0);
  const containerRow = rows.find((r) => !r.issueRef && !r.parentMissionId);
  const capUsd = containerRow?.budgetUsd ?? null;
  const pct = capUsd && capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : null;
  return { spentUsd, capUsd, pct };
}

/** All of one user's missions for a repo (container + issue leaves), rolled up. */
export async function getRepoBudget(userId: string, repo: string): Promise<RepoBudget> {
  // Spend is computed live from each mission's task cost, not from the
  // denormalised `missions.spent_usd` column: that column is written only when
  // a budgeted mission crosses its soft threshold, so an unbudgeted or
  // below-threshold mission read 0 here even after burning real tokens — the
  // repo page showed $0 while the Missions view showed the true figure. The
  // LEFT JOIN keeps container rows (which own no tasks) at 0, as before.
  const rows = await db
    .select({
      spentTokens: sql<number>`coalesce(sum(${tasks.costTokens}), 0)`,
      budgetUsd: missions.budgetUsd,
      issueRef: missions.issueRef,
      parentMissionId: missions.parentMissionId,
    })
    .from(missions)
    .leftJoin(tasks, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), eq(missions.workspaceRepo, repo)))
    .groupBy(missions.id);
  return computeRepoBudget(
    rows.map((r) => ({
      spentUsd: tokensToUsd(Number(r.spentTokens)),
      budgetUsd: r.budgetUsd,
      issueRef: r.issueRef,
      parentMissionId: r.parentMissionId,
    })),
  );
}
