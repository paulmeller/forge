import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
const DB_FILE = `/tmp/forge-server-test-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // unreachable — exercised only for the 404 paths below

let client: { close: () => void };

beforeAll(async () => {
  const dbMod = await import('./db');
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../packages/db/migrations'),
  });
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

describe('GET /tasks/:taskId/stream', () => {
  it('404s for an unknown task', async () => {
    const { buildServer } = await import('./server');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/tasks/tsk_does_not_exist/stream' });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a task with no sessionId yet', async () => {
    const { db } = await import('./db');
    const { tasks, missions } = await import('@forge/db');
    const now = new Date();
    await db.insert(missions).values({
      id: 'msn_stream_test',
      userId: 'usr_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: 'tsk_no_session',
      missionId: 'msn_stream_test',
      repo: 'acme/api',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const { buildServer } = await import('./server');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/tasks/tsk_no_session/stream' });
    expect(res.statusCode).toBe(404);
  });
});
