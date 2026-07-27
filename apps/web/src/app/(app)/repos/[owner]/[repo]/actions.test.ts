import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { EscalationReason, TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-repo-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  cancelSession: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('@/server/tick/adapters', () => ({
  getAdapter: () => ({ cancelSession: mocks.cancelSession }),
}));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let abortTask: typeof import('./actions').abortTask;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ abortTask } = await import('./actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function seedTask(over: {
  id: string;
  status: TaskStatus;
  approvedBy?: string | null;
  escalationReason?: EscalationReason | null;
  sessionId?: string | null;
  userId?: string;
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
    approvedBy: over.approvedBy ?? null,
    escalationReason: over.escalationReason ?? null,
    sessionId: over.sessionId === undefined ? 'sess_1' : over.sessionId,
    createdAt: now,
    updatedAt: now,
  });
}

async function getTaskRow(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  if (!row) throw new Error(`no such task: ${id}`);
  return row;
}

describe('abortTask', () => {
  beforeAll(() => {
    mocks.withAuth.mockResolvedValue({ id: 'u1', name: 'Owner', email: 'u1@x.com' });
  });

  it('clears a stale approvedBy when aborting a ready_to_merge task with a live session', async () => {
    // The approval, once forced to `failed`, no longer describes anything —
    // this is the manual-abort twin of budgets.ts's hard-stop fix.
    await seedTask({ id: 'tsk_abort_rtm', status: 'ready_to_merge', approvedBy: 'u1' });
    const result = await abortTask('tsk_abort_rtm');
    expect(result).toEqual({ ok: true });
    const row = await getTaskRow('tsk_abort_rtm');
    expect(row.status).toBe('failed');
    expect(row.approvedBy).toBeNull();
  });

  it('clears a stale escalationReason when aborting a needs_human task with a live session', async () => {
    // Asserted on its own fixture, independent of the approvedBy assertion
    // above, so a mutant dropping only one of the two clears is caught by a
    // uniquely-named, unambiguous failure.
    await seedTask({
      id: 'tsk_abort_nh',
      status: 'needs_human',
      escalationReason: 'ai_review_rejected',
    });
    const result = await abortTask('tsk_abort_nh');
    expect(result).toEqual({ ok: true });
    const row = await getTaskRow('tsk_abort_nh');
    expect(row.status).toBe('failed');
    expect(row.escalationReason).toBeNull();
  });

  it('refuses to abort a task with no active session', async () => {
    await seedTask({ id: 'tsk_abort_nosess', status: 'running', sessionId: null });
    const result = await abortTask('tsk_abort_nosess');
    expect(result).toEqual({ ok: false, error: 'Task has no active session to abort' });
  });

  it('refuses to abort a task belonging to another user', async () => {
    await seedTask({ id: 'tsk_abort_other', status: 'running', userId: 'someone_else' });
    const result = await abortTask('tsk_abort_other');
    expect(result).toEqual({ ok: false, error: 'Task not found' });
  });
});
