import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { missions, tasks, type Task, type TaskStatus } from '@forge/db';

import { db } from './db';
import { isIssueMission } from './mission-shape';
import { listUserRepos } from './mission-defaults-db';

export type HomeTaskRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isStanding: boolean;
};

const NOW_RUNNING_STATUSES = [
  'dispatching',
  'running',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
] as const;

const NEEDS_YOU_STATUSES = ['awaiting_review', 'failed'] as const;

const RECENT_OUTCOME_STATUSES = ['merged', 'resolved'] as const;

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
    isStanding: isIssueMission({ issueRef: r.issueRef }),
  }));
}

/** Active Tasks across both modes — the "what's happening right now" section. */
export function getNowRunning(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NOW_RUNNING_STATUSES, limit, false);
}

/** Tasks that need a human — awaiting review, or failed. */
export function getNeedsYou(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NEEDS_YOU_STATUSES, limit, false);
}

/** Most recent terminal successes — merged PRs, resolved reproduce verdicts. */
export function getRecentOutcomes(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, RECENT_OUTCOME_STATUSES, limit, true);
}

export type RepoActivity = { repo: string; activeCount: number; totalCount: number };

/**
 * Per-repo Task counts (both modes) for the "Your repos" cards. Counts are
 * DB-derived Task activity, not live GitHub issue counts — the latter would
 * cost one API call per repo per page load.
 */
export async function getRepoActivity(userId: string): Promise<RepoActivity[]> {
  const repos = await listUserRepos(userId);
  if (repos.length === 0) return [];

  const [totalRows, activeRows] = await Promise.all([
    db
      .select({ repo: tasks.repo, total: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(and(eq(missions.userId, userId), isNotNull(tasks.repo)))
      .groupBy(tasks.repo),
    db
      .select({ repo: tasks.repo, active: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(
          eq(missions.userId, userId),
          isNotNull(tasks.repo),
          inArray(tasks.status, NOW_RUNNING_STATUSES),
        ),
      )
      .groupBy(tasks.repo),
  ]);

  const byRepo = new Map(totalRows.map((r) => [r.repo, { active: 0, total: Number(r.total) }]));
  for (const r of activeRows) {
    const entry = byRepo.get(r.repo);
    if (entry) entry.active = Number(r.active);
    else byRepo.set(r.repo, { active: Number(r.active), total: 0 });
  }
  return repos.map((repo) => ({
    repo,
    activeCount: byRepo.get(repo)?.active ?? 0,
    totalCount: byRepo.get(repo)?.total ?? 0,
  }));
}
