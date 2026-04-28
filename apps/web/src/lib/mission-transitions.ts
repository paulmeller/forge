import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { ledgerEvents, missions, type Mission, type MissionStatus } from '@forge/db';

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
