import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type MissionStatus } from '@forge/db';

import { db } from './db';

export class MissionTransitionError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'WRONG_STATUS',
  ) {
    super(message);
    this.name = 'MissionTransitionError';
  }
}

/** Transition a Mission status with an optimistic WHERE guard. */
async function transitionMission(
  missionId: string,
  from: MissionStatus,
  to: MissionStatus,
  eventType: string,
  extra?: Partial<Mission>,
): Promise<Mission> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: to, updatedAt: now, ...extra })
    .where(and(eq(missions.id, missionId), eq(missions.status, from)))
    .returning();

  if (!updated) {
    const [row] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!row) throw new MissionTransitionError('mission not found', 'NOT_FOUND');
    throw new MissionTransitionError(
      `expected mission in ${from}, got ${row.status}`,
      'WRONG_STATUS',
    );
  }

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: updated.id,
    eventType,
    payload: { from, to },
    createdAt: now,
  });

  return updated;
}

export function startMission(missionId: string): Promise<Mission> {
  return transitionMission(missionId, 'planning', 'running', 'mission.started', {
    startedAt: new Date(),
  });
}

export function pauseMission(missionId: string): Promise<Mission> {
  return transitionMission(missionId, 'running', 'paused', 'mission.paused');
}

export function resumeMission(missionId: string): Promise<Mission> {
  return transitionMission(missionId, 'paused', 'running', 'mission.resumed');
}

export async function cancelMission(missionId: string): Promise<Mission> {
  const [current] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!current) throw new MissionTransitionError('mission not found', 'NOT_FOUND');
  if (current.status !== 'running' && current.status !== 'paused') {
    throw new MissionTransitionError(
      `expected mission in running or paused, got ${current.status}`,
      'WRONG_STATUS',
    );
  }

  return transitionMission(missionId, current.status, 'cancelled', 'mission.cancelled', {
    completedAt: new Date(),
  });
}

export async function retryMission(
  missionId: string,
): Promise<{ mission: Mission; retriedCount: number }> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const resetTasks = await tx
      .update(tasks)
      .set({
        status: 'queued',
        lastError: null,
        completedAt: null,
        sessionId: null,
        updatedAt: now,
      })
      .where(and(eq(tasks.missionId, missionId), inArray(tasks.status, ['failed', 'abandoned'])))
      .returning({ id: tasks.id });

    const [mission] = await tx
      .update(missions)
      .set({ status: 'running', completedAt: null, updatedAt: now })
      .where(and(eq(missions.id, missionId), eq(missions.status, 'completed')))
      .returning();

    if (!mission) {
      const [row] = await tx.select().from(missions).where(eq(missions.id, missionId)).limit(1);
      if (!row) throw new MissionTransitionError('mission not found', 'NOT_FOUND');
      throw new MissionTransitionError(
        `expected mission in completed, got ${row.status}`,
        'WRONG_STATUS',
      );
    }

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'mission.retried',
      payload: { from: 'completed', to: 'running', retriedCount: resetTasks.length },
      createdAt: now,
    });

    return { mission, retriedCount: resetTasks.length };
  });
}
