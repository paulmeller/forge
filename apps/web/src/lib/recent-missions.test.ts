import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { missions } from '@forge/db';

import { listRecentMissions } from './recent-missions';

const DB_PATH = vi.hoisted(() => `/tmp/forge-recent-missions-${process.pid}.db`);

vi.mock('./db', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const client = createClient({ url: `file:${DB_PATH}` });
  return { db: drizzle(client) };
});

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const client = createClient({ url: `file:${DB_PATH}` });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: '../../packages/db/migrations' });
});

afterAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

function insertMission(overrides: Partial<typeof missions.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId: 'user_1',
    name: 'test mission',
    goal: 'test goal',
    status: 'running' as const,
    backend: 'managed-agents' as const,
    agentId: 'agent_1',
    plannerStrategy: 'rule-based' as const,
    targetRepos: ['owner/repo'],
    concurrencyCap: 1,
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('listRecentMissions', () => {
  it('returns the most recent missions for a user, newest first, limited', async () => {
    const older = insertMission({ id: 'msn_older00000000001', name: 'older', createdAt: new Date(Date.now() - 10000) });
    const newer = insertMission({ id: 'msn_newer00000000002', name: 'newer', createdAt: new Date() });
    const other = insertMission({ id: 'msn_other00000000003', name: 'other user', userId: 'user_2' });
    await db.insert(missions).values([older, newer, other]);

    const result = await listRecentMissions('user_1', 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'msn_newer00000000002', name: 'newer' });
    expect(result[1]).toMatchObject({ id: 'msn_older00000000001', name: 'older' });
  });

  it('returns an empty array for a user with no missions', async () => {
    const result = await listRecentMissions('user_no_missions', 2);
    expect(result).toEqual([]);
  });
});
