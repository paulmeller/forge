import { asc, eq, inArray } from 'drizzle-orm';

import { missions, tasks, type Task } from '@forge/db';

import { db } from './db';

export async function listTasksForMission(missionId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .orderBy(asc(tasks.createdAt));
}

/**
 * List every task belonging to any issue leaf mission under a repo's
 * container — what the Repo Workspace page shows. A container owns no
 * tasks directly (see workspace-mission.ts), so this walks its children
 * first rather than querying tasks.missionId against the container's own
 * id (which would always be empty).
 */
export async function listTasksForWorkspace(containerId: string): Promise<Task[]> {
  const children = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.parentMissionId, containerId));
  if (children.length === 0) return [];

  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.missionId, children.map((c) => c.id)))
    .orderBy(asc(tasks.createdAt));
}

export async function getTask(id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}
