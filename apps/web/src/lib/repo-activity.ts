import { and, desc, eq } from 'drizzle-orm';

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
