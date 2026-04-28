import { desc, eq } from 'drizzle-orm';

import { ledgerEvents, type LedgerEvent } from '@forge/db';

import { db } from './db';

export async function listLedgerForTask(taskId: string, limit = 200): Promise<LedgerEvent[]> {
  return db
    .select()
    .from(ledgerEvents)
    .where(eq(ledgerEvents.taskId, taskId))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(limit);
}

export async function listLedgerForMission(
  missionId: string,
  limit = 200,
): Promise<LedgerEvent[]> {
  return db
    .select()
    .from(ledgerEvents)
    .where(eq(ledgerEvents.missionId, missionId))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(limit);
}
