import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-plan-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  addTaskSpy: vi.fn(),
  removeTaskSpy: vi.fn(),
  updateTaskPromptVarsSpy: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/task-edits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/task-edits')>();
  return {
    ...actual,
    addTask: (...args: Parameters<typeof actual.addTask>) => {
      mocks.addTaskSpy(...args);
      return actual.addTask(...args);
    },
    removeTask: (...args: Parameters<typeof actual.removeTask>) => {
      mocks.removeTaskSpy(...args);
      return actual.removeTask(...args);
    },
    updateTaskPromptVars: (...args: Parameters<typeof actual.updateTaskPromptVars>) => {
      mocks.updateTaskPromptVarsSpy(...args);
      return actual.updateTaskPromptVars(...args);
    },
  };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let addTaskAction: typeof import('./actions').addTaskAction;
let removeTaskAction: typeof import('./actions').removeTaskAction;
let updatePromptVarsAction: typeof import('./actions').updatePromptVarsAction;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ addTaskAction, removeTaskAction, updatePromptVarsAction } = await import('./actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.withAuth.mockReset();
  mocks.addTaskSpy.mockClear();
  mocks.removeTaskSpy.mockClear();
  mocks.updateTaskPromptVarsSpy.mockClear();
});

function authAs(id: string) {
  mocks.withAuth.mockResolvedValueOnce({ id, name: id, email: `${id}@x.com` });
}

async function insertMission(id: string, userId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId,
    name: 'Test mission',
    goal: 'test',
    status: 'planning',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
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
    repo: 'acme/widgets',
    baseBranch: 'main',
    status: 'queued',
    promptVars: { repo: 'acme/widgets', base_branch: 'main' },
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function tasksFor(missionId: string) {
  return db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
}

describe('addTaskAction', () => {
  it('adds a task for the mission owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');
    authAs('owner_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('repo', 'acme/widgets');
    const result = await addTaskAction({}, fd);

    expect(result).toEqual({});
    expect((await tasksFor(missionId))).toHaveLength(1);
  });

  it('refuses to add a task to a mission owned by someone else, and never calls addTask', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');
    authAs('attacker_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('repo', 'acme/widgets');
    const result = await addTaskAction({}, fd);

    expect(result.error).toBeDefined();
    expect((await tasksFor(missionId))).toHaveLength(0);
    expect(mocks.addTaskSpy).not.toHaveBeenCalled();
  });

  it('never reaches addTask for an unauthenticated caller', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_3');
    mocks.withAuth.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('repo', 'acme/widgets');

    await expect(addTaskAction({}, fd)).rejects.toThrow('NEXT_REDIRECT');
    expect((await tasksFor(missionId))).toHaveLength(0);
    expect(mocks.addTaskSpy).not.toHaveBeenCalled();
  });
});

describe('removeTaskAction', () => {
  it('removes a task for the mission owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');
    await insertTask(taskId, missionId);
    authAs('owner_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);
    const result = await removeTaskAction({}, fd);

    expect(result).toEqual({});
    expect((await tasksFor(missionId))).toHaveLength(0);
  });

  it('refuses to remove a task from a mission owned by someone else, and never calls removeTask', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');
    await insertTask(taskId, missionId);
    authAs('attacker_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);
    const result = await removeTaskAction({}, fd);

    expect(result.error).toBeDefined();
    expect((await tasksFor(missionId))).toHaveLength(1);
    expect(mocks.removeTaskSpy).not.toHaveBeenCalled();
  });

  it('never reaches removeTask for an unauthenticated caller', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_3');
    await insertTask(taskId, missionId);
    mocks.withAuth.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);

    await expect(removeTaskAction({}, fd)).rejects.toThrow('NEXT_REDIRECT');
    expect((await tasksFor(missionId))).toHaveLength(1);
    expect(mocks.removeTaskSpy).not.toHaveBeenCalled();
  });
});

describe('updatePromptVarsAction', () => {
  it('updates prompt vars for the mission owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');
    await insertTask(taskId, missionId);
    authAs('owner_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);
    fd.set('promptVars', JSON.stringify({ repo: 'acme/other' }));
    const result = await updatePromptVarsAction({}, fd);

    expect(result).toEqual({});
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task?.promptVars).toEqual({ repo: 'acme/other' });
  });

  it('refuses to update prompt vars on a mission owned by someone else, and never calls updateTaskPromptVars', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');
    await insertTask(taskId, missionId);
    authAs('attacker_1');

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);
    fd.set('promptVars', JSON.stringify({ repo: 'acme/other' }));
    const result = await updatePromptVarsAction({}, fd);

    expect(result.error).toBeDefined();
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task?.promptVars).toEqual({ repo: 'acme/widgets', base_branch: 'main' });
    expect(mocks.updateTaskPromptVarsSpy).not.toHaveBeenCalled();
  });

  it('never reaches updateTaskPromptVars for an unauthenticated caller', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_3');
    await insertTask(taskId, missionId);
    mocks.withAuth.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));

    const fd = new FormData();
    fd.set('missionId', missionId);
    fd.set('taskId', taskId);
    fd.set('promptVars', JSON.stringify({ repo: 'acme/other' }));

    await expect(updatePromptVarsAction({}, fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.updateTaskPromptVarsSpy).not.toHaveBeenCalled();
  });
});
