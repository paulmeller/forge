import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { EscalationReason, Task, TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-review-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  getTask: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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
let reviewAction: typeof import('./review-actions').reviewAction;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ reviewAction } = await import('./review-actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(() => {
  // Default caller for every test unless a test overrides it below.
  mocks.withAuth.mockResolvedValue({ id: 'u1', name: 'Owner', email: 'u1@x.com' });
});

afterEach(() => {
  mocks.withAuth.mockReset();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedTask(over: {
  id: string;
  status: TaskStatus;
  escalationReason?: EscalationReason | null;
  userId?: string;
  approvedBy?: string | null;
}): Promise<void> {
  const now = new Date();
  const missionId = `msn_${over.id}`;
  await db.insert(schema.missions).values({
    id: missionId,
    userId: over.userId ?? 'u1',
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
    missionId,
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

async function getTaskRow(id: string): Promise<Task> {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!row) throw new Error(`no such task: ${id}`);
  return row as Task;
}

describe('reviewAction', () => {
  it('approve moves needs_human to ready_to_merge and clears the reason', async () => {
    await seedTask({ id: 'tsk_1', status: 'needs_human', escalationReason: 'ai_review_rejected' });
    const result = await reviewAction(formData({ taskId: 'tsk_1', op: 'approve' }));
    expect(result).toEqual({ ok: true });
    const t = await getTaskRow('tsk_1');
    expect(t.status).toBe('ready_to_merge');
    expect(t.escalationReason).toBeNull();
    expect(t.approvedBy).toBe('u1');
  });

  it('dismiss abandons the task', async () => {
    await seedTask({ id: 'tsk_2', status: 'needs_human' });
    const result = await reviewAction(formData({ taskId: 'tsk_2', op: 'dismiss' }));
    expect(result).toEqual({ ok: true });
    expect((await getTaskRow('tsk_2')).status).toBe('abandoned');
  });

  it('dismiss clears a stale approvedBy from an earlier approve/rollback cycle', async () => {
    // Reproduces the exploit precondition: a task that was approved once,
    // then bounced back to needs_human (auto-merge rollback / gate stall /
    // verify or AI-review escalation) without anything clearing approvedBy.
    // Dismissing it must not leave that stale approval sitting there for a
    // future retryMission'd re-run to inherit.
    await seedTask({ id: 'tsk_2b', status: 'needs_human', approvedBy: 'u1' });
    const result = await reviewAction(formData({ taskId: 'tsk_2b', op: 'dismiss' }));
    expect(result).toEqual({ ok: true });
    const row = await getTaskRow('tsk_2b');
    expect(row.status).toBe('abandoned');
    expect(row.approvedBy).toBeNull();
  });

  it('refuses a task belonging to another user, and leaves it untouched', async () => {
    await seedTask({ id: 'tsk_3', status: 'needs_human', userId: 'someone_else' });
    const res = await reviewAction(formData({ taskId: 'tsk_3', op: 'approve' }));
    expect(res.error).toBe('task not found');
    const row = await getTaskRow('tsk_3');
    expect(row.status).toBe('needs_human');
    expect(row.approvedBy).toBeNull();
  });

  it('refuses to approve a task that is not awaiting a human, and leaves it untouched', async () => {
    await seedTask({ id: 'tsk_4', status: 'running' });
    const res = await reviewAction(formData({ taskId: 'tsk_4', op: 'approve' }));
    expect(res.error).toBeDefined();
    const row = await getTaskRow('tsk_4');
    expect(row.status).toBe('running');
    expect(row.approvedBy).toBeNull();
  });

  it('never reaches the database write for an unauthenticated caller (withAuth throws/redirects first)', async () => {
    await seedTask({ id: 'tsk_5', status: 'needs_human' });
    mocks.withAuth.mockReset();
    mocks.withAuth.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));

    await expect(reviewAction(formData({ taskId: 'tsk_5', op: 'approve' }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    const row = await getTaskRow('tsk_5');
    expect(row.status).toBe('needs_human');
  });

  it('loses a genuine race to a concurrent transition instead of clobbering it', async () => {
    // Every other test in this file short-circuits on the earlier
    // `task.status !== 'needs_human'` precondition check, so none of them
    // exercise the CAS `.where()` guard on the write itself — dropping
    // `eq(tasks.status, 'needs_human')` from that `.where()` would leave
    // every other test passing. This forces a genuine race: getTask reads a
    // needs_human snapshot, then — before reviewAction's own write runs —
    // the row is mutated out from under it (simulating a concurrent sweep
    // or a second reviewAction call), so the guarded update must affect
    // zero rows.
    await seedTask({ id: 'tsk_race', status: 'needs_human' });
    const actualTasks = await vi.importActual<typeof import('@/lib/tasks')>('@/lib/tasks');
    mocks.getTask.mockImplementationOnce(async (id: string, userId: string) => {
      const row = await actualTasks.getTask(id, userId);
      await db
        .update(schema.tasks)
        .set({ status: 'abandoned', updatedAt: new Date() })
        .where(eq(schema.tasks.id, id));
      return row; // stale snapshot: still reports needs_human
    });

    const res = await reviewAction(formData({ taskId: 'tsk_race', op: 'approve' }));

    expect(res.error).toBe('task is no longer awaiting a human');
    const row = await getTaskRow('tsk_race');
    // If the `eq(tasks.status, 'needs_human')` clause were ever dropped from
    // the approve branch's `.where()`, this update would match on id alone,
    // "win" the race it should have lost, and clobber the concurrent
    // transition — status would be 'ready_to_merge' and approvedBy would be
    // 'u1'. Neither must happen.
    expect(row.status).toBe('abandoned');
    expect(row.approvedBy).toBeNull();
  });
});
