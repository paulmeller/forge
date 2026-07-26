import { and, asc, eq, inArray } from 'drizzle-orm';

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

/**
 * Ownership-scoped lookup — userId is required (not optional/defaulted) so
 * the compiler forces every call site to supply the caller's identity.
 * Tasks carry no userId of their own (see schema.ts), so ownership is
 * established by joining to the owning mission. A task that exists but
 * belongs to someone else's mission returns null, identical to a
 * nonexistent id, so existence isn't observable across accounts.
 */
export async function getTask(id: string, userId: string): Promise<Task | null> {
  const [row] = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(tasks.id, id), eq(missions.userId, userId)))
    .limit(1);
  return row?.task ?? null;
}
