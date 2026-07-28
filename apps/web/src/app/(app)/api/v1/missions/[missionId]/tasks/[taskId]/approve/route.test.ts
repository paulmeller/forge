import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { EscalationReason, Task, TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-v1-task-approve-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  getTask: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));
// Defaults to the real getTask (call-through) for every test. The one test
// that needs to force a genuine lost race overrides this with
// mockImplementationOnce to mutate the row between the read and the write.
vi.mock('@/lib/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks')>();
  mocks.getTask.mockImplementation(actual.getTask);
  return { ...actual, getTask: (...args: Parameters<typeof actual.getTask>) => mocks.getTask(...args) };
});

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
  escalationReason?: EscalationReason | null;
  userId?: string;
  approvedBy?: string | null;
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
    escalationReason: over.escalationReason ?? null,
    approvedBy: over.approvedBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

async function taskRow(id: string): Promise<Task> {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!row) throw new Error(`no such task: ${id}`);
  return row as Task;
}

describe('POST /api/v1/missions/[missionId]/tasks/[taskId]/approve', () => {
  it('approve moves needs_human to ready_to_merge', async () => {
    await seedTask({ missionId: 'm_mine', id: 't1', status: 'needs_human', escalationReason: 'ai_review_rejected' });
    authAs('owner_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_mine', 't1'));

    expect(res.status).toBe(200);
    const row = await taskRow('t1');
    expect(row.status).toBe('ready_to_merge');
    expect(row.escalationReason).toBeNull();
    expect(row.approvedBy).toBe('owner_1');
  });

  it("404s and writes nothing for another user's task", async () => {
    await seedTask({ missionId: 'm_theirs', id: 't_theirs', status: 'needs_human', userId: 'owner_2' });
    authAs('attacker_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_theirs', 't_theirs'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    const row = await taskRow('t_theirs');
    expect(row.status).toBe('needs_human');
    expect(row.approvedBy).toBeNull();
  });

  it('404s for a nonexistent task id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_mine', 't_does_not_exist'));
    expect(res.status).toBe(404);
  });

  it('refuses to approve a task that is not awaiting a human, and leaves it untouched', async () => {
    await seedTask({ missionId: 'm_running', id: 't_running', status: 'running' });
    authAs('owner_1');

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_running', 't_running'));

    expect(res.status).toBe(409);
    // Exact message, not just "an error occurred": the CAS guard on the
    // write below would ALSO refuse this (producing 'task is no longer
    // awaiting a human') even if this early precondition were deleted
    // entirely, so asserting only the status code can't tell the two apart.
    expect((await res.json()).error.message).toBe('task is running, not awaiting a human');
    const row = await taskRow('t_running');
    expect(row.status).toBe('running');
    expect(row.approvedBy).toBeNull();
  });

  it('loses a genuine race to a concurrent transition instead of clobbering it', async () => {
    await seedTask({ missionId: 'm_race', id: 't_race', status: 'needs_human' });
    authAs('owner_1');

    const actualTasks = await vi.importActual<typeof import('@/lib/tasks')>('@/lib/tasks');
    // The route itself calls getTask once (the ownership/nesting precheck)
    // before reviewTask calls it again internally to do the actual CAS
    // write. The race must be simulated on that SECOND call — if it fired
    // on the first, the precheck's mutation would already be visible by the
    // time reviewTask's own (unmutated) precondition check ran, and that
    // precondition — not the CAS — would be what caught it, masking this
    // mutant instead of catching it. So: first call passes through
    // untouched, second call is the stale-snapshot-plus-concurrent-write.
    mocks.getTask.mockImplementationOnce(actualTasks.getTask);
    mocks.getTask.mockImplementationOnce(async (id: string, userId: string) => {
      const row = await actualTasks.getTask(id, userId);
      await db.update(schema.tasks).set({ status: 'abandoned', updatedAt: new Date() }).where(eq(schema.tasks.id, id));
      return row; // stale snapshot: still reports needs_human
    });

    const res = await POST(new Request('http://x', { method: 'POST' }), params('m_race', 't_race'));

    expect(res.status).toBe(409);
    const row = await taskRow('t_race');
    // If the CAS `where` clause were dropped, this update would match on id
    // alone and clobber the concurrent transition.
    expect(row.status).toBe('abandoned');
    expect(row.approvedBy).toBeNull();
  });
});
