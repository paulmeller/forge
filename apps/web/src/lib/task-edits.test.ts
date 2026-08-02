import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-task-edits-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let addTask: typeof import('./task-edits').addTask;
let removeTask: typeof import('./task-edits').removeTask;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ addTask, removeTask } = await import('./task-edits'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertPlanningMission(id: string) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'planning',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
}

describe('removeTask ledger durability', () => {
  it('does not delete the ledger event recorded when the removed task was added', async () => {
    // The ledger is promised as an auditable record (docs/forge-prd.md:
    // "Every action is tracked in an auditable Ledger"). addTask writes a
    // planner.task_added event with ledgerEvents.taskId set to the new
    // task's id; removeTask then hard-deletes that task row. Before the
    // fix, ledgerEvents.taskId had onDelete: 'cascade', so deleting the
    // task silently erased the very event that recorded its creation.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertPlanningMission(missionId);

    const task = await addTask(missionId, { repo: 'acme/api' });

    const [addedEvent] = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.taskId, task.id));
    expect(addedEvent).toBeDefined();

    await removeTask(missionId, task.id);

    const [survivingEvent] = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.id, addedEvent!.id));
    expect(survivingEvent).toBeDefined();
  });
});
