import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { missions, tasks } from '@forge/db';

const DB_PATH = vi.hoisted(() => `/tmp/forge-backend-session-ref-${process.pid}.db`);

vi.mock('@/lib/db', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  return { db: drizzle(createClient({ url: `file:${DB_PATH}` })) };
});

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(createClient({ url: `file:${DB_PATH}` }));
  await migrate(db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
});

afterAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe('backendSessionRef persistence', () => {
  it('stores a rotated ref so it survives a process restart', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = new Date();

    await db.insert(missions).values({
      id: missionId,
      userId: 'user_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'gemini-managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'rule-based',
      targetRepos: ['owner/repo'],
      concurrencyCap: 1,
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: taskId,
      missionId,
      repo: 'owner/repo',
      baseBranch: 'main',
      status: 'awaiting_ci',
      sessionId: 'v1_first',
      backendSessionRef: 'v1_first',
      createdAt: now,
      updatedAt: now,
    });

    // What a sendTurn rotation writes.
    await db
      .update(tasks)
      .set({ backendSessionRef: 'v1_second', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    // sessionId must NOT rotate — it anchors the adapter's synthetic event ids.
    expect(row!.sessionId).toBe('v1_first');
    expect(row!.backendSessionRef).toBe('v1_second');
  });

  it('defaults backendSessionRef to null for a task that never set it', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = new Date();

    await db.insert(missions).values({
      id: missionId,
      userId: 'user_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'rule-based',
      targetRepos: ['owner/repo'],
      concurrencyCap: 1,
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: taskId,
      missionId,
      repo: 'owner/repo',
      baseBranch: 'main',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row!.backendSessionRef).toBeNull();
  });
});
