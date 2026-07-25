import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-repo-activity-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listTasksTouchingRepo: typeof import('./repo-activity').listTasksTouchingRepo;
let countMissionsThisMonth: typeof import('./repo-activity').countMissionsThisMonth;
let countBlockedTasksByRepo: typeof import('./repo-activity').countBlockedTasksByRepo;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listTasksTouchingRepo, countMissionsThisMonth, countBlockedTasksByRepo } = await import('./repo-activity'));
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

async function insertTask(id: string, missionId: string, repo: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo,
    baseBranch: 'main',
    kind: 'standard',
    status: 'merged',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('listTasksTouchingRepo', () => {
  it('returns tasks from both a campaign mission and an issue leaf mission for the same repo, but not tasks for a different repo', async () => {
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(campaignId, { workspaceRepo: null, targetRepos: ['acme/api'] });
    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(leafId, { workspaceRepo: 'acme/api', issueRef: 'acme/api#1', parentMissionId: containerId });

    await insertTask('tsk_campaign', campaignId, 'acme/api');
    await insertTask('tsk_issue', leafId, 'acme/api', { kind: 'fix', issueRef: 'acme/api#1' });
    await insertTask('tsk_other_repo', campaignId, 'acme/web');

    const rows = await listTasksTouchingRepo('user_1', 'acme/api');
    const ids = rows.map((r) => r.task.id);

    expect(ids).toContain('tsk_campaign');
    expect(ids).toContain('tsk_issue');
    expect(ids).not.toContain('tsk_other_repo');

    const campaignRow = rows.find((r) => r.task.id === 'tsk_campaign')!;
    const issueRow = rows.find((r) => r.task.id === 'tsk_issue')!;
    expect(campaignRow.isIssueMission).toBe(false);
    expect(issueRow.isIssueMission).toBe(true);
  });
});

describe('countMissionsThisMonth', () => {
  it('counts missions targeting this repo created this calendar month', async () => {
    const thisMonthId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const lastMonthId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const otherRepoId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(thisMonthId, { targetRepos: ['owner/repo'] });
    await insertMission(lastMonthId, {
      targetRepos: ['owner/repo'],
      createdAt: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15),
    });
    await insertMission(otherRepoId, { targetRepos: ['owner/other'] });

    const count = await countMissionsThisMonth('user_1', 'owner/repo');
    expect(count).toBe(1);
  });

  it('returns 0 for a repo with no missions this month', async () => {
    const count = await countMissionsThisMonth('user_1', 'owner/nonexistent');
    expect(count).toBe(0);
  });
});

describe('countBlockedTasksByRepo', () => {
  it('counts tasks in awaiting_review status, grouped by repo, for a user', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { targetRepos: ['owner/repo'] });
    await insertTask('tsk_blocked0000000001', missionId, 'owner/repo', { status: 'awaiting_review' });
    await insertTask('tsk_blocked0000000002', missionId, 'owner/repo', { status: 'awaiting_review' });
    await insertTask('tsk_running00000000003', missionId, 'owner/repo', { status: 'running' });

    const result = await countBlockedTasksByRepo('user_1');
    expect(result.get('owner/repo')).toBe(2);
  });

  it('omits repos with zero blocked tasks from the map', async () => {
    const result = await countBlockedTasksByRepo('user_with_no_blockers');
    expect(result.has('owner/repo')).toBe(false);
  });
});
