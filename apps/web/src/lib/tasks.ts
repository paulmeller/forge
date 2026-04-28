import { asc, eq } from 'drizzle-orm';

import { tasks, type Task } from '@forge/db';

import { db } from './db';

export async function listTasksForMission(missionId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .orderBy(asc(tasks.createdAt));
}

export async function getTask(id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}
