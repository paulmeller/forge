import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { Task, TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-v1-task-abort-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  cancelSession: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));
vi.mock('@/server/tick/adapters', () => ({
  getAdapter: () => ({ cancelSession: mocks.cancelSession }),
}));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let POST: typeof import('./route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ POST } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(() => {
  mocks.cancelSession.mockReset();
  mocks.cancelSession.mockResolvedValue(undefined);
});

afterEach(() => {
  mocks.apiAuth.mockReset();
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

function params(missionId: string, taskId: string) {
  return { params: Promise.resolve({ missionId, taskId }) };
}

async function seedTask(over: {
  missionId: string;
  id: string;
  status: TaskStatus;
  userId?: string;
  sessionId?: string | null;
}): Promise<void> {
  const now = new Date();
  await db.insert(schema.missions).values({
    id: over.missionId,
    userId: over.userId ?? 'owner_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.tasks).values({
    id: over.id,
    missionId: over.missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'fix',
    status: over.status,
    sessionId: over.sessionId === undefined ? 'sess_1' : over.sessionId,
    createdAt: now,
    updatedAt: now,
  });
}

async function taskRow(id: string): Promise<Task> {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!row) throw new Error(`no such task: ${id}`);
  return row as Task;
}

describe('POST /api/v1/missions/[missionId]/tasks/[taskId]/abort', () => {
  it('aborts a running task with a live session', async () => {
    await seedTask({ missionId: 'm_mine', id: 't1', status: 'running' });
    authAs('owner_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_mine', 't1'));

    expect(res.status).toBe(200);
    const row = await taskRow('t1');
    expect(row.status).toBe('failed');
    expect(row.haltReason).toBe('manual_abort');
  });

  it("404s and writes nothing for another user's task", async () => {
    await seedTask({ missionId: 'm_theirs', id: 't_theirs', status: 'running', userId: 'owner_2' });
    authAs('attacker_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_theirs', 't_theirs'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    const row = await taskRow('t_theirs');
    expect(row.status).toBe('running');
    expect(mocks.cancelSession).not.toHaveBeenCalled();
  });

  it('refuses to abort a task with no active session', async () => {
    await seedTask({ missionId: 'm_nosess', id: 't_nosess', status: 'running', sessionId: null });
    authAs('owner_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_nosess', 't_nosess'));

    expect(res.status).toBe(409);
    expect((await taskRow('t_nosess')).status).toBe('running');
  });
});
