import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-missions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listMissionsForUser: typeof import('./missions').listMissionsForUser;
let getMission: typeof import('./missions').getMission;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listMissionsForUser, getMission } = await import('./missions'));
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

describe('listMissionsForUser', () => {
  it('excludes a pure container (workspaceRepo set, no issueRef, no parent) but includes everything else', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const issueLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(issueLeafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertMission(campaignId, { workspaceRepo: null, issueRef: null, parentMissionId: null });

    const rows = await listMissionsForUser('user_1');
    const ids = rows.map((m) => m.id);

    expect(ids).not.toContain(containerId);
    expect(ids).toContain(issueLeafId);
    expect(ids).toContain(campaignId);
  });
});

describe('getMission', () => {
  it('returns the mission to its owner', async () => {
    const id = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(id, { userId: 'owner_1' });

    const row = await getMission(id, 'owner_1');
    expect(row?.id).toBe(id);
  });

  it('returns null for the same mission queried as a different user (IDOR guard)', async () => {
    const id = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(id, { userId: 'owner_2' });

    const row = await getMission(id, 'attacker_1');
    expect(row).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    const row = await getMission('msn_does_not_exist', 'owner_1');
    expect(row).toBeNull();
  });
});
