import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';

import { ledgerEvents, type LedgerEvent } from '@forge/db';

import { db } from './db';

export interface LedgerPage {
  events: LedgerEvent[];
  nextCursor: string | null;
}

/**
 * Opaque keyset cursor over (createdAt, id) — the same pair
 * ledger_mission_created_idx/ledger_task_created_idx are built on.
 * sourceEventId can't serve as the cursor: it's only set for
 * backend-originated events (see schema.ts) and isn't unique across tasks
 * at mission scope, so an internally-generated or cross-task row would
 * break a keyset built on it. `id` is unique and present on every row, and
 * breaks ties within the same createdAt millisecond.
 */
function encodeCursor(event: LedgerEvent): string {
  return Buffer.from(`${event.createdAt.getTime()}:${event.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  return { createdAt: new Date(Number(ms)), id: id! };
}

/** Everything strictly after `cursor` in the same (createdAt, id) DESC order the query sorts by. */
function afterCursor(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const { createdAt, id } = decodeCursor(cursor);
  return or(
    lt(ledgerEvents.createdAt, createdAt),
    and(eq(ledgerEvents.createdAt, createdAt), lt(ledgerEvents.id, id)),
  );
}

/** Fetches limit+1 rows so "was there more?" is a length check, not a second query. */
function toPage(rows: LedgerEvent[], limit: number): LedgerPage {
  const events = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { events, nextCursor: hasMore ? encodeCursor(events[events.length - 1]!) : null };
}

export async function listLedgerForTask(
  taskId: string,
  limit = 200,
  cursor?: string,
): Promise<LedgerPage> {
  const scope = eq(ledgerEvents.taskId, taskId);
  const cond = afterCursor(cursor);
  const rows = await db
    .select()
    .from(ledgerEvents)
    .where(cond ? and(scope, cond) : scope)
    .orderBy(desc(ledgerEvents.createdAt), desc(ledgerEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit);
}

export async function listLedgerForMission(
  missionId: string,
  limit = 200,
  cursor?: string,
): Promise<LedgerPage> {
  const scope = eq(ledgerEvents.missionId, missionId);
  const cond = afterCursor(cursor);
  const rows = await db
    .select()
    .from(ledgerEvents)
    .where(cond ? and(scope, cond) : scope)
    .orderBy(desc(ledgerEvents.createdAt), desc(ledgerEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit);
}
