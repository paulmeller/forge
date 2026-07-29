import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// getRepoBudget used to sum the denormalised `missions.spent_usd` column,
// which is written only as a side effect of a budget soft-pause — so a repo
// whose leaf missions had burned real tokens still reported $0 on the repo
// page while the Missions view (which computes live) showed the true figure.
// This exercises the live computation against a real schema; it fails against
// the stale-column implementation.

const DB_FILE = `/tmp/forge-repo-budget-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let getRepoBudget: typeof import('./repo-budget').getRepoBudget;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ getRepoBudget } = await import('./repo-budget'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function mission(over: Record<string, unknown>) {
  const now = new Date();
  await db.insert(schema.missions).values({
    userId: 'user_1',
    name: 'm',
    goal: 'g',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 's',
    // The stale column stays 0 on purpose — the bug was reading THIS.
    spentUsd: 0,
    spentTokens: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as typeof schema.missions.$inferInsert);
}

async function task(id: string, missionId: string, costTokens: number) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'merged',
    costTokens,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.tasks.$inferInsert);
}

describe('getRepoBudget computes spend live from task cost, not the stale column', () => {
  it('reports the leaf missions real token spend even though spent_usd is 0', async () => {
    // Container (no tasks) with a $100 cap, plus a leaf that burned 2,000,000
    // tokens. At $5 / 1M that is $10 — the container's spent_usd is 0.
    await mission({ id: 'msn_c', workspaceRepo: 'acme/api', budgetUsd: 100 });
    await mission({ id: 'msn_leaf', workspaceRepo: 'acme/api', issueRef: 'acme/api#1', parentMissionId: 'msn_c' });
    await task('tsk_1', 'msn_leaf', 2_000_000);

    const b = await getRepoBudget('user_1', 'acme/api');
    expect(b.spentUsd).toBe(10);
    expect(b.capUsd).toBe(100);
    expect(b.pct).toBe(10);
  });

  it('does not count another user\'s missions on the same repo name', async () => {
    await mission({ id: 'msn_other', userId: 'user_2', workspaceRepo: 'acme/api' });
    await task('tsk_other', 'msn_other', 9_000_000);

    // user_1's figure is unchanged by user_2's spend on the same repo string.
    const b = await getRepoBudget('user_1', 'acme/api');
    expect(b.spentUsd).toBe(10);
  });
});
