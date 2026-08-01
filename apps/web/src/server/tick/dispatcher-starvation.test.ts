import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// #84: the container-cap arithmetic counts `needs_human` and `ready_to_merge`
// as in-flight (INFLIGHT_STATUSES), so a container full of zombie Tasks in
// those states computes zero slots for every leaf mission underneath it —
// forever, with claimed always 0 and no way to tell that apart from "nothing
// queued". Real libSQL file, nothing faked (no GitHub calls happen on this
// path) — same pattern as dispatch-from-github.test.ts.
const DB_FILE = `/tmp/forge-dispatch-starve-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runDispatcher: typeof import('./dispatcher').runDispatcher;

const log = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runDispatcher } = await import('./dispatcher'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(async () => {
  await db.delete(schema.missions);
});

async function insertMission(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    concurrencyCap: 5,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function ledgerEventsFor(missionId: string) {
  return db
    .select()
    .from(schema.ledgerEvents)
    .where(and(eq(schema.ledgerEvents.missionId, missionId)));
}

describe('runDispatcher — container-cap starvation signal (#84)', () => {
  it('reports starved and writes a dispatch.starved ledger event when the container cap computes zero slots with queued work waiting', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { concurrencyCap: 5 });
    await insertMission(leafId, { parentMissionId: containerId, concurrencyCap: 5 });

    // Five zombie siblings under the container, all counted in-flight
    // (INFLIGHT_STATUSES), pin the container's cap of five.
    for (let i = 0; i < 3; i++) {
      await insertTask(`tsk_zombie_nh_${i}`, leafId, { status: 'needs_human' });
    }
    for (let i = 0; i < 2; i++) {
      await insertTask(`tsk_zombie_rtm_${i}`, leafId, { status: 'ready_to_merge' });
    }
    // The Task actually waiting to go — this is the one that silently never
    // gets claimed in the reported bug.
    await insertTask('tsk_queued', leafId, { status: 'queued' });

    const result = await runDispatcher(log);

    expect(result.claimed).toBe(0);
    expect(result.starved).toBe(1);

    const events = await ledgerEventsFor(leafId);
    const starved = events.find((e) => e.eventType === 'dispatch.starved');
    expect(starved).toBeDefined();
  });

  it('does not report starved when the container cap is zero but nothing is queued', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { concurrencyCap: 1 });
    await insertMission(leafId, { parentMissionId: containerId, concurrencyCap: 5 });
    await insertTask('tsk_running', leafId, { status: 'running' });

    const result = await runDispatcher(log);

    expect(result.starved).toBe(0);
    const events = await ledgerEventsFor(leafId);
    expect(events.find((e) => e.eventType === 'dispatch.starved')).toBeUndefined();
  });

  it('does not repeat the ledger event tick after tick while nothing else changes', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { concurrencyCap: 1 });
    await insertMission(leafId, { parentMissionId: containerId, concurrencyCap: 5 });
    await insertTask('tsk_zombie', leafId, { status: 'needs_human' });
    await insertTask('tsk_queued', leafId, { status: 'queued' });

    await runDispatcher(log);
    await runDispatcher(log);
    const result = await runDispatcher(log);

    expect(result.starved).toBe(1); // still true every tick...
    const events = await ledgerEventsFor(leafId);
    // ...but only ledgered once, since nothing changed in between.
    expect(events.filter((e) => e.eventType === 'dispatch.starved')).toHaveLength(1);
  });
});
