import { and, desc, eq, sql } from 'drizzle-orm';

import { missions, tasks, type Task } from '@forge/db';

import { db } from './db';
import { isIssueMission } from './mission-shape';

export type RepoActivityRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isIssueMission: boolean;
};

/**
 * Every Task that has touched this repo from either mode — campaign tasks
 * (via `tasks.repo`) and issue-leaf tasks alike. This is the Activity tab's
 * data source: where the two modes visibly meet on one repo's timeline.
 */
export async function listTasksTouchingRepo(userId: string, repo: string): Promise<RepoActivityRow[]> {
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      issueRef: missions.issueRef,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), eq(tasks.repo, repo)))
    .orderBy(desc(tasks.updatedAt));

  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isIssueMission: isIssueMission({ issueRef: r.issueRef }),
  }));
}

/** Missions targeting this repo created since the start of the current
 *  calendar month — the repo workspace identity zone's "missions this
 *  month" stat. Follows the same plain-Date-timestamp comparison style
 *  as getDashboardStats's `weekAgo` in home.ts, not a date library. */
export async function countMissionsThisMonth(userId: string, repo: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const rows = await db
    .select({ id: missions.id, targetRepos: missions.targetRepos })
    .from(missions)
    .where(and(eq(missions.userId, userId), sql`${missions.createdAt} >= ${monthStart}`));

  return rows.filter((m) => (m.targetRepos ?? []).includes(repo)).length;
}

/** Maps repo -> count of that repo's tasks currently in `needs_human`
 *  ("escalated to a human for any reason" — see merge-stepper.ts for why
 *  this is the one real proxy Forge has for "this needs attention today").
 *  Repos with zero such tasks are omitted from the returned map. */
export async function countBlockedTasksByRepo(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ repo: tasks.repo, count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), eq(tasks.status, 'needs_human')))
    .groupBy(tasks.repo);

  return new Map(rows.map((r) => [r.repo, Number(r.count)]));
}
