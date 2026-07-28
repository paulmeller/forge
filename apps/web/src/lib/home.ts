import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, missions, tasks, type Task, type TaskStatus } from '@forge/db';

import { db } from './db';
import { isIssueMission } from './mission-shape';

export type HomeTaskRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isIssueMission: boolean;
};

const NOW_RUNNING_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'merging',
] as const;

// `ready_to_merge` belongs here alongside `needs_human`/`failed`: whether or
// not the owning Mission has an auto-merge policy, a Task sitting here is
// either waiting on a human to merge it (no policy, or requireHumanApproval)
// or waiting on the next tick's runAutoMerge to act — either way it's work a
// human can usefully see now, not invisible in-flight work (see reconciler.ts's
// missionTerminalStatusesFor for the mission-completion side of this same gap).
const NEEDS_YOU_STATUSES = ['needs_human', 'failed', 'ready_to_merge'] as const;

const RECENT_OUTCOME_STATUSES = ['merged', 'resolved', 'abandoned'] as const;

async function queryTasksByStatus(
  userId: string,
  statuses: readonly TaskStatus[],
  limit: number,
  orderByCompletedAt: boolean,
): Promise<HomeTaskRow[]> {
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      issueRef: missions.issueRef,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), inArray(tasks.status, statuses)))
    .orderBy(orderByCompletedAt ? desc(tasks.completedAt) : desc(tasks.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isIssueMission: isIssueMission({ issueRef: r.issueRef }),
  }));
}

/** In-flight Tasks across both modes — the Working section. */
export function getNowRunning(userId: string, limit = 20): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NOW_RUNNING_STATUSES, limit, false);
}

/** Tasks that need a human — awaiting review, or failed/halted. */
export function getNeedsYou(userId: string, limit = 20): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NEEDS_YOU_STATUSES, limit, false);
}

/** Most recent terminal results — merged, resolved, or abandoned. */
export function getRecentOutcomes(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, RECENT_OUTCOME_STATUSES, limit, true);
}

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
