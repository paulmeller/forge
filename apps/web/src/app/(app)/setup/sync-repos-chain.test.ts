import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

/**
 * End-to-end closure of the four-hop authorization chain:
 *
 *   syncRepos (this dir's actions.ts) -> github_installation_repos row
 *     -> userCanAccessRepo (mission-defaults-db.ts)
 *       -> toggleNextMarker (repos/[owner]/[repo]/actions.ts) mints a container
 *         -> updateRepoSettings (repos/[owner]/[repo]/settings-actions.ts)
 *            flips repoPolicy.requirePlanApproval
 *
 * Each of those hops already has its own unit coverage elsewhere
 * (actions.test.ts in both directories). This file proves the chain as a
 * whole is closed: an attacker who owns nothing but their own legitimate
 * installation cannot ride syncRepos into naming a victim's repo, and a
 * genuine multi-repo selection still works end to end through the same
 * three calls.
 */

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  createInstallationAccessToken: vi.fn(),
  listInstallationRepositories: vi.fn(),
  cancelSession: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('@/lib/github-app-auth', () => ({
  createInstallationAccessToken: mocks.createInstallationAccessToken,
  listInstallationRepositories: mocks.listInstallationRepositories,
}));
// toggleNextMarker's module (repos/[owner]/[repo]/actions.ts) imports
// getAdapter at module scope even though toggleNextMarker itself never
// calls it — mirrors the same mock in that directory's own actions.test.ts.
vi.mock('@/server/tick/adapters', () => ({
  getAdapter: () => ({ cancelSession: mocks.cancelSession }),
}));

const DB_FILE = `/tmp/forge-sync-repos-chain-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let syncRepos: typeof import('./actions').syncRepos;
let toggleNextMarker: typeof import('../repos/[owner]/[repo]/actions').toggleNextMarker;
let updateRepoSettings: typeof import('../repos/[owner]/[repo]/settings-actions').updateRepoSettings;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ syncRepos } = await import('./actions'));
  ({ toggleNextMarker } = await import('../repos/[owner]/[repo]/actions'));
  ({ updateRepoSettings } = await import('../repos/[owner]/[repo]/settings-actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.withAuth.mockReset();
  mocks.createInstallationAccessToken.mockReset();
  mocks.listInstallationRepositories.mockReset();
});

async function insertInstallation(id: string, userId: string, installationId: number): Promise<void> {
  const now = new Date();
  await db.insert(schema.githubInstallations).values({
    id,
    userId,
    installationId,
    accountLogin: 'acme-org',
    accountType: 'Organization',
    agentId: 'agent_1',
    createdAt: now,
    updatedAt: now,
  });
}

async function insertRepo(
  id: string,
  installationId: string,
  repo: string,
  repoPolicy?: { requirePlanApproval: boolean } | null,
): Promise<void> {
  await db
    .insert(schema.githubInstallationRepos)
    .values({ id, installationId, repo, repoPolicy: repoPolicy ?? null, createdAt: new Date() });
}

async function repoPolicyRow(installationId: string, repo: string) {
  const [row] = await db
    .select()
    .from(schema.githubInstallationRepos)
    .where(
      and(
        eq(schema.githubInstallationRepos.installationId, installationId),
        eq(schema.githubInstallationRepos.repo, repo),
      ),
    );
  return row ?? null;
}

async function findContainerMission(userId: string, workspaceRepo: string) {
  const [row] = await db
    .select()
    .from(schema.missions)
    .where(
      and(
        eq(schema.missions.userId, userId),
        eq(schema.missions.workspaceRepo, workspaceRepo),
        isNull(schema.missions.issueRef),
        isNull(schema.missions.parentMissionId),
      ),
    );
  return row ?? null;
}

function validSettingsInput(overrides: { requirePlanApproval?: boolean } = {}) {
  return {
    concurrencyCap: 5,
    budgetUsd: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    autoMerge: { enabled: false },
    requirePlanApproval: true,
    ...overrides,
  };
}

describe("the reviewer's chained attack, one hop further upstream: syncRepos -> toggleNextMarker -> updateRepoSettings", () => {
  it(
    "an attacker with their own legitimate installation cannot sync a victim's repo into " +
      'github_installation_repos, mint a container over it, or flip its plan-approval gate',
    async () => {
      // Victim: a real installation over their own repo, synced legitimately,
      // plan approval on.
      const victimInstId = 'inst_victim';
      await insertInstallation(victimInstId, 'victim', 900001);
      await insertRepo('ghr_victim', victimInstId, 'victim-org/victim-repo', {
        requirePlanApproval: true,
      });

      // Attacker: a real installation too — legitimately installed on their
      // own account — but GitHub only grants it the attacker's own repo.
      const attackerInstId = 'inst_attacker';
      await insertInstallation(attackerInstId, 'attacker', 900002);

      mocks.withAuth.mockResolvedValue({ id: 'attacker', name: 'Attacker', email: 'attacker@x.com' });

      // Step 0 (the new hop this closes): try to plant a github_installation_repos
      // row for the victim's repo under the attacker's own installation.
      // listInstallationRepositories is mocked to answer as GitHub really
      // would — only the attacker's own repos.
      mocks.createInstallationAccessToken.mockResolvedValueOnce('fake-attacker-token');
      mocks.listInstallationRepositories.mockResolvedValueOnce(['attacker-org/attacker-repo']);

      const syncResult = await syncRepos(attackerInstId, ['victim-org/victim-repo']);
      expect(syncResult).toEqual({
        error: 'Installation does not grant access to: victim-org/victim-repo',
      });

      // No row was planted — userCanAccessRepo has nothing to say yes to.
      expect(await repoPolicyRow(attackerInstId, 'victim-org/victim-repo')).toBeNull();

      // Step 1: with nothing planted, the repo-access gate on toggleNextMarker
      // refuses to mint a container for the victim's repo under the attacker.
      const toggleResult = await toggleNextMarker(
        'victim-org/victim-repo',
        'victim-org/victim-repo#1',
        true,
      );
      expect(toggleResult.ok).toBe(false);
      const minted = await findContainerMission('attacker', 'victim-org/victim-repo');
      expect(minted).toBeNull();

      // Step 2: with no container minted, there is no live id for
      // updateRepoSettings to act on — attempting it against a nonexistent id
      // (all the chain leaves the attacker) fails too.
      const settingsResult = await updateRepoSettings(
        minted?.id ?? 'msn_does_not_exist',
        validSettingsInput({ requirePlanApproval: false }),
      );
      expect(settingsResult.ok).toBe(false);

      // End to end: the victim's plan-approval gate never moved.
      expect((await repoPolicyRow(victimInstId, 'victim-org/victim-repo'))?.repoPolicy).toEqual({
        requirePlanApproval: true,
      });
    },
  );

  it('a legitimate user selecting repos their installation genuinely covers still succeeds end to end', async () => {
    const instId = 'inst_legit';
    await insertInstallation(instId, 'legit', 900003);
    mocks.withAuth.mockResolvedValue({ id: 'legit', name: 'Legit', email: 'legit@x.com' });

    // The picker's underlying create-token-then-list-repos call reports this
    // installation genuinely covers both repos.
    mocks.createInstallationAccessToken.mockResolvedValueOnce('fake-legit-token');
    mocks.listInstallationRepositories.mockResolvedValueOnce([
      'legit-org/legit-repo',
      'legit-org/other-repo',
    ]);

    const syncResult = await syncRepos(instId, ['legit-org/legit-repo', 'legit-org/other-repo']);
    expect(syncResult).toBeUndefined();
    expect(await repoPolicyRow(instId, 'legit-org/legit-repo')).toBeTruthy();

    const toggleResult = await toggleNextMarker(
      'legit-org/legit-repo',
      'legit-org/legit-repo#5',
      true,
    );
    expect(toggleResult).toEqual({ ok: true });
    const container = await findContainerMission('legit', 'legit-org/legit-repo');
    expect(container).toBeTruthy();
    expect(container?.nextIssueRefs).toContain('legit-org/legit-repo#5');

    const settingsResult = await updateRepoSettings(
      container!.id,
      validSettingsInput({ requirePlanApproval: false }),
    );
    expect(settingsResult).toEqual({ ok: true });
    expect((await repoPolicyRow(instId, 'legit-org/legit-repo'))?.repoPolicy).toEqual({
      requirePlanApproval: false,
    });
  });
});
