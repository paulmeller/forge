import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLICY } from '@/lib/policy-file';

import type { AutoMergePolicy } from '@forge/db';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// resolveAutoMergePolicy now consults resolveRepoPolicy for the .forge/
// policy.yml gate (#40) before it falls through to the column reads below,
// which this file otherwise exercises against a real migrated libSQL db.
// Mocking only this one function keeps that db real while keeping the test
// off the network — resolveRepoPolicy's own file/db/default precedence is
// covered by resolve-repo-policy.test.ts, not re-tested here.
const mockResolveRepoPolicy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/repo-policy', () => ({ resolveRepoPolicy: mockResolveRepoPolicy }));

describe('resolveAutoMergePolicy', () => {
  // Point the real ./db module at a throwaway libSQL file BEFORE it is
  // imported (mirrors apps/tick/src/reconciler.test.ts and gate-flags.test.ts).
  const DB_FILE = `/tmp/forge-auto-merge-policy-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
  process.env.DATABASE_URL = `file:${DB_FILE}`;

  let db: LibSQLDatabase<Record<string, unknown>>;
  let client: { close: () => void };
  let schema: typeof import('@forge/db');
  let resolveAutoMergePolicy: typeof import('./auto-merge-policy').resolveAutoMergePolicy;

  beforeAll(async () => {
    const dbMod = await import('@/lib/db');
    db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
    client = dbMod.client as unknown as { close: () => void };
    await migrate(dbMod.db, {
      migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
    });
    schema = await import('@forge/db');
    ({ resolveAutoMergePolicy } = await import('./auto-merge-policy'));
  });

  afterAll(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
    }
  });

  beforeEach(() => {
    // No file, by default — every pre-existing test in this file exercises
    // the column-based resolution below and expects resolveRepoPolicy to be
    // a no-op ("no .forge/policy.yml") unless a test says otherwise.
    mockResolveRepoPolicy.mockReset().mockResolvedValue({ source: 'default', policy: DEFAULT_POLICY });
  });

  async function seedMission(over: {
    id: string;
    parentMissionId?: string | null;
    autoMergePolicy?: AutoMergePolicy | null;
    workspaceRepo?: string | null;
    issueRef?: string | null;
    targetRepos?: string[] | null;
    userId?: string;
  }) {
    const now = new Date();
    const { id, parentMissionId = null, autoMergePolicy = null, userId = 'user_1', ...rest } = over;
    await db.insert(schema.missions).values({
      id,
      userId,
      name: 'Test mission',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'triage',
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
      parentMissionId,
      autoMergePolicy,
      ...rest,
    });
  }

  it('returns a standalone mission its own policy', async () => {
    await seedMission({ id: 'm_solo', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 10 } });
    expect(await resolveAutoMergePolicy('m_solo')).toEqual({ enabled: true, maxAdditions: 10 });
  });

  it("returns the CONTAINER's policy for an issue leaf, not the leaf's own", async () => {
    // The live-lookup property: enabling auto-merge on a repo must take
    // effect for leaves that already exist, without recreating them.
    await seedMission({ id: 'm_container', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 5 } });
    await seedMission({ id: 'm_leaf', parentMissionId: 'm_container', autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_leaf')).toEqual({ enabled: true, maxAdditions: 5 });
  });

  it("prefers the container's policy even when the leaf has one of its own", async () => {
    await seedMission({ id: 'm_c2', parentMissionId: null, autoMergePolicy: { enabled: false } });
    await seedMission({ id: 'm_l2', parentMissionId: 'm_c2', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_l2')).toEqual({ enabled: false });
  });

  it("falls back to the leaf's own policy when the parent row is missing", async () => {
    await seedMission({ id: 'm_orphan', parentMissionId: 'm_gone', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_orphan')).toEqual({ enabled: true });
  });

  it('returns null for a mission that does not exist', async () => {
    expect(await resolveAutoMergePolicy('m_missing')).toBeNull();
  });

  it('returns null when no policy is configured anywhere', async () => {
    await seedMission({ id: 'm_nopolicy', parentMissionId: null, autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_nopolicy')).toBeNull();
  });

  it("gives an @forge mission (targetRepos, no workspaceRepo/parentMissionId) its repo's container policy", async () => {
    // dispatchFromGithub (the @forge entry point) creates a standalone
    // mission with targetRepos set but no workspaceRepo or parentMissionId —
    // it has no container id to follow, so the resolver must find the
    // container the same way updateRepoSettings writes to it: by
    // workspaceRepo. Issue #34.
    await seedMission({
      id: 'm_repo_container',
      parentMissionId: null,
      workspaceRepo: 'acme/widgets',
      autoMergePolicy: { enabled: true, maxAdditions: 20 },
    });
    await seedMission({
      id: 'm_forge_mention',
      parentMissionId: null,
      workspaceRepo: null,
      targetRepos: ['acme/widgets'],
      autoMergePolicy: null,
    });
    expect(await resolveAutoMergePolicy('m_forge_mention')).toEqual({ enabled: true, maxAdditions: 20 });
  });

  it("does not inherit another user's container policy for the same repo", async () => {
    // The by-repo-name lookup above can match a container belonging to a
    // DIFFERENT user — two accounts can both connect the same GitHub repo.
    // Unlike the parentMissionId path, which follows a reference the mission
    // already holds, this one is name-based and so must be owner-scoped:
    // auto-merge is the highest-stakes policy in the product and must never be
    // enabled by a stranger's configuration.
    await seedMission({
      id: 'm_other_users_container',
      userId: 'user_other',
      parentMissionId: null,
      workspaceRepo: 'acme/gadgets',
      autoMergePolicy: { enabled: true, maxAdditions: 20 },
    });
    await seedMission({
      id: 'm_forge_mention_u1',
      parentMissionId: null,
      workspaceRepo: null,
      targetRepos: ['acme/gadgets'],
      autoMergePolicy: null,
    });

    expect(await resolveAutoMergePolicy('m_forge_mention_u1')).toBeNull();
  });

  it('takes the auto-merge policy from the repo policy file when present', async () => {
    // One reader, one answer. Before this, policy resolved differently
    // depending on which code path asked — which is how #34 happened.
    mockResolveRepoPolicy.mockResolvedValue({
      source: 'file',
      policy: { ...DEFAULT_POLICY, autoMerge: { enabled: true, maxAdditions: 5 } },
    });
    await seedMission({ id: 'm_file', parentMissionId: null, workspaceRepo: 'acme/widgets' });

    expect(await resolveAutoMergePolicy('m_file')).toEqual({ enabled: true, maxAdditions: 5 });
  });

  it('yields no auto-merge when the repo policy file is invalid, rather than falling through to columns', async () => {
    // An invalid file must never merge — falling through to the column
    // reads below could enable auto-merge the operator never configured via
    // a file they believe replaced the database entirely.
    mockResolveRepoPolicy.mockResolvedValue({ source: 'invalid', error: 'autoMerg: unrecognized key' });
    await seedMission({
      id: 'm_invalid_file',
      parentMissionId: null,
      workspaceRepo: 'acme/widgets',
      autoMergePolicy: { enabled: true, maxAdditions: 20 },
    });

    expect(await resolveAutoMergePolicy('m_invalid_file')).toBeNull();
  });
});
