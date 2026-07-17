import { and, eq } from 'drizzle-orm';

import { missions, type Mission } from '@forge/db';

import { db } from './db';

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
  const rows = await db
    .select({
      spentUsd: missions.spentUsd,
      budgetUsd: missions.budgetUsd,
      issueRef: missions.issueRef,
      parentMissionId: missions.parentMissionId,
    })
    .from(missions)
    .where(and(eq(missions.userId, userId), eq(missions.workspaceRepo, repo)));
  return computeRepoBudget(rows);
}
