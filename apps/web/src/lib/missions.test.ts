import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-missions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

// Wraps the real userCanAccessRepo so most tests exercise the genuine DB-backed
// check (grantRepoAccess below), while the "fails closed" test can override a
// single call with mockImplementationOnce to simulate the lookup throwing.
const mocks = vi.hoisted(() => ({ userCanAccessRepo: vi.fn() }));
vi.mock('./mission-defaults-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-defaults-db')>();
  mocks.userCanAccessRepo.mockImplementation(actual.userCanAccessRepo);
  return { ...actual, userCanAccessRepo: mocks.userCanAccessRepo };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listMissionsForUser: typeof import('./missions').listMissionsForUser;
let getMission: typeof import('./missions').getMission;
let createMissionForUser: typeof import('./missions').createMissionForUser;
let RepoAccessError: typeof import('./missions').RepoAccessError;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listMissionsForUser, getMission, createMissionForUser, RepoAccessError } = await import(
    './missions'
  ));
});

/** Grants `userId` access to `repo` the same way a real Setup installation does. */
async function grantRepoAccess(userId: string, repo: string) {
  const now = new Date();
  const installationRowId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.githubInstallations).values({
    id: installationRowId,
    userId,
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId: installationRowId,
    repo,
    createdAt: now,
  });
}

function baseCreateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Test mission',
    goal: 'ship the thing',
    backend: 'managed-agents' as const,
    agentId: 'agent_1',
    plannerStrategy: 'rule-based' as const,
    targetRepos: [],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    budgetHardStopPct: 100,
    taskMaxTurns: null,
    taskMaxTokens: null,
    noProgressTokens: null,
    githubInstallationId: null,
    githubVaultId: null,
    skillId: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    ...overrides,
  };
}

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.userCanAccessRepo.mockClear();
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

  // The two used to disagree: listMissionsForUser excluded containers,
  // getMission did not, so every /api/v1 lifecycle route accepted a
  // container id that GET /api/v1/missions never returned. Both now run the
  // same notAContainer() predicate — this pins that agreement from the
  // getMission side, and the case immediately below proves the filter is
  // specific to containers rather than to repo-scoped missions generally.
  it("returns null for the owner's own repo container — never addressable by mission id", async () => {
    const id = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(id, {
      userId: 'owner_3',
      workspaceRepo: 'acme/api',
      issueRef: null,
      parentMissionId: null,
    });

    expect(await getMission(id, 'owner_3')).toBeNull();
    expect((await listMissionsForUser('owner_3')).map((m) => m.id)).not.toContain(id);
  });

  it('still returns an issue leaf, which is repo-scoped but is a unit of work', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { userId: 'owner_4', workspaceRepo: 'acme/api' });
    await insertMission(leafId, {
      userId: 'owner_4',
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#7',
      parentMissionId: containerId,
    });

    expect((await getMission(leafId, 'owner_4'))?.id).toBe(leafId);
  });
});

describe('createMissionForUser', () => {
  it('rejects the whole call when any targetRepo is inaccessible, and writes no mission row', async () => {
    const userId = `user_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await grantRepoAccess(userId, 'a/b');
    // Deliberately no access granted to c/d.

    const countBefore = (await db.select().from(schema.missions)).length;

    await expect(
      createMissionForUser(userId, baseCreateInput({ targetRepos: ['a/b', 'c/d'] }) as never),
    ).rejects.toBeInstanceOf(RepoAccessError);

    const countAfter = (await db.select().from(schema.missions)).length;
    expect(countAfter).toBe(countBefore);
  });

  it('creates the mission when the caller has access to every targetRepo', async () => {
    const userId = `user_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await grantRepoAccess(userId, 'a/b');
    await grantRepoAccess(userId, 'c/d');

    const mission = await createMissionForUser(
      userId,
      baseCreateInput({ targetRepos: ['a/b', 'c/d'] }) as never,
    );

    expect(mission.targetRepos).toEqual(['a/b', 'c/d']);
  });

  it('allows creation with an empty targetRepos list (no repo to check)', async () => {
    const userId = `user_${randomUUID().replaceAll('-', '').slice(0, 8)}`;

    const mission = await createMissionForUser(userId, baseCreateInput({ targetRepos: [] }) as never);

    expect(mission.targetRepos).toEqual([]);
  });

  it('fails closed and writes no mission row when the access lookup itself throws', async () => {
    const userId = `user_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await grantRepoAccess(userId, 'a/b');
    mocks.userCanAccessRepo.mockImplementationOnce(async () => {
      throw new Error('db unavailable');
    });

    const countBefore = (await db.select().from(schema.missions)).length;

    await expect(
      createMissionForUser(userId, baseCreateInput({ targetRepos: ['a/b'] }) as never),
    ).rejects.toThrow('db unavailable');

    const countAfter = (await db.select().from(schema.missions)).length;
    expect(countAfter).toBe(countBefore);
  });
});
