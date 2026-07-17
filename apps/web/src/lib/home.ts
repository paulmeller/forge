import { and, eq, inArray, sql } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, missions, tasks } from '@forge/db';

import { db } from './db';

export type DashboardStats = {
  mergedThisWeek: number;
  activeAgents: number;
  spentUsd: number;
  connectedRepos: number;
};

/**
 * Cross-cutting operator stats shown as the metric-card row on /home. Also
 * consumed by /missions (just `connectedRepos`, for its "connect your
 * repos" empty-state banner) — one query, two consumers, rather than
 * duplicating the DB reads.
 */
export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const [mergedRows, activeRows, spendRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(
          eq(missions.userId, userId),
          eq(tasks.status, 'merged'),
          sql`${tasks.completedAt} >= ${weekAgo}`,
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(
          eq(missions.userId, userId),
          inArray(tasks.status, ['dispatching', 'running', 'turn_ended']),
        ),
      ),
    db
      .select({ total: sql<number>`coalesce(sum(${missions.spentUsd}), 0)` })
      .from(missions)
      .where(eq(missions.userId, userId)),
  ]);

  // Repo count query is separate — table may not exist in dev
  let repoRows: { count: number }[] = [{ count: 0 }];
  try {
    repoRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(githubInstallationRepos)
      .innerJoin(
        githubInstallations,
        eq(githubInstallationRepos.installationId, githubInstallations.id),
      )
      .where(eq(githubInstallations.userId, userId));
  } catch {
    // Table doesn't exist yet — that's fine
  }

  return {
    mergedThisWeek: Number(mergedRows[0]?.count ?? 0),
    activeAgents: Number(activeRows[0]?.count ?? 0),
    spentUsd: Number(spendRows[0]?.total ?? 0),
    connectedRepos: Number(repoRows[0]?.count ?? 0),
  };
}
