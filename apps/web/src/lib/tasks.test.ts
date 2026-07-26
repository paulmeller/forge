import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-tasks-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listTasksForWorkspace: typeof import('./tasks').listTasksForWorkspace;
let getTask: typeof import('./tasks').getTask;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listTasksForWorkspace, getTask } = await import('./tasks'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
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
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertTask(id: string, missionId: string) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'fix',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  });
}

describe('listTasksForWorkspace', () => {
  it('returns tasks from every issue leaf under the container, but none from the container itself', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafAId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafBId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const otherContainerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const unrelatedLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(leafAId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertMission(leafBId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#2',
      parentMissionId: containerId,
    });
    await insertMission(otherContainerId, { workspaceRepo: 'acme/other', issueRef: null, parentMissionId: null });
    await insertMission(unrelatedLeafId, {
      workspaceRepo: 'acme/other',
      issueRef: 'acme/other#1',
      parentMissionId: otherContainerId,
    });

    await insertTask('tsk_leaf_a', leafAId);
    await insertTask('tsk_leaf_b', leafBId);
    await insertTask('tsk_unrelated', unrelatedLeafId);

    const rows = await listTasksForWorkspace(containerId);
    const ids = rows.map((t) => t.id);

    expect(ids).toContain('tsk_leaf_a');
    expect(ids).toContain('tsk_leaf_b');
    expect(ids).not.toContain('tsk_unrelated');
  });

  it('returns an empty array for a container with no issue leaves yet', async () => {
    const emptyContainerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(emptyContainerId, { workspaceRepo: 'acme/empty', issueRef: null, parentMissionId: null });

    const rows = await listTasksForWorkspace(emptyContainerId);
    expect(rows).toEqual([]);
  });
});

describe('getTask', () => {
  it("returns the task to its mission's owner", async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { userId: 'owner_1' });
    await insertTask(taskId, missionId);

    const row = await getTask(taskId, 'owner_1');
    expect(row?.id).toBe(taskId);
    expect(row?.missionId).toBe(missionId);
  });

  it("returns null for the same task queried as a different user (IDOR guard)", async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { userId: 'owner_2' });
    await insertTask(taskId, missionId);

    const row = await getTask(taskId, 'attacker_1');
    expect(row).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    const row = await getTask('tsk_does_not_exist', 'owner_1');
    expect(row).toBeNull();
  });
});
