import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Real libSQL file + migrations, same pattern as dispatch-from-github.test.ts —
// getRepoPolicy is a direct pass-through of a stored JSON column, and the
// point of this suite is to prove what actually comes back from a real row,
// not what a mocked query builder is told to return.
const DB_FILE = `/tmp/forge-repo-policy-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let getRepoPolicy: typeof import('./repo-policy').getRepoPolicy;
let getRepoPolicyForUser: typeof import('./repo-policy').getRepoPolicyForUser;
let getOnboardingInfoForUser: typeof import('./repo-policy').getOnboardingInfoForUser;
let DEFAULT_REPO_POLICY: typeof import('./repo-policy').DEFAULT_REPO_POLICY;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ getRepoPolicy, getRepoPolicyForUser, getOnboardingInfoForUser, DEFAULT_REPO_POLICY } =
    await import('./repo-policy'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(async () => {
  await db.delete(schema.githubInstallations); // cascades to githubInstallationRepos
});

/**
 * Inserts a github_installation_repos row (and its owning installation) with
 * an arbitrary (possibly malformed) policy value. Returns the numeric GitHub
 * installation id the row was created under, since getRepoPolicy is now
 * scoped by it (C2).
 */
async function insertRepoRow(repo: string, policy: unknown): Promise<number> {
  const now = new Date();
  const installationRowId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const installationId = Math.floor(Math.random() * 1_000_000);
  await db.insert(schema.githubInstallations).values({
    id: installationRowId,
    userId: 'user_test',
    installationId,
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId: installationRowId,
    repo,
    // Bypass the RepoPolicy type on purpose — the whole point of these tests
    // is to see what getRepoPolicy does with data that shouldn't exist but
    // might (e.g. hand-edited rows, a future writer with a bug).
    repoPolicy: policy as never,
    createdAt: now,
  });
  return installationId;
}

describe('getRepoPolicy', () => {
  it('gates (requirePlanApproval: true) a repo with no row at all', async () => {
    const policy = await getRepoPolicy('nobody/here', 123456);
    expect(policy).toEqual(DEFAULT_REPO_POLICY);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('gates a repo with a row but no policy column set', async () => {
    const installationId = await insertRepoRow('a/no-policy', null);
    const policy = await getRepoPolicy('a/no-policy', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('gates a repo whose policy is an empty object', async () => {
    const installationId = await insertRepoRow('a/empty-policy', {});
    const policy = await getRepoPolicy('a/empty-policy', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('ungates only on an explicit requirePlanApproval: false', async () => {
    const installationId = await insertRepoRow('a/opted-out', { requirePlanApproval: false });
    const policy = await getRepoPolicy('a/opted-out', installationId);
    expect(policy.requirePlanApproval).toBe(false);
  });

  it('fails closed when requirePlanApproval is null (malformed data)', async () => {
    const installationId = await insertRepoRow('a/malformed-null', { requirePlanApproval: null });
    const policy = await getRepoPolicy('a/malformed-null', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is 0 (malformed data)', async () => {
    const installationId = await insertRepoRow('a/malformed-zero', { requirePlanApproval: 0 });
    const policy = await getRepoPolicy('a/malformed-zero', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is an empty string (malformed data)', async () => {
    const installationId = await insertRepoRow('a/malformed-string', { requirePlanApproval: '' });
    const policy = await getRepoPolicy('a/malformed-string', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is "false" the string, not the boolean (malformed data)', async () => {
    const installationId = await insertRepoRow('a/malformed-string-false', {
      requirePlanApproval: 'false',
    });
    const policy = await getRepoPolicy('a/malformed-string-false', installationId);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('is scoped per repo — one repo opting out does not affect another', async () => {
    const optedOutId = await insertRepoRow('a/opted-out-2', { requirePlanApproval: false });
    const gatedId = await insertRepoRow('a/still-gated', { requirePlanApproval: true });
    expect((await getRepoPolicy('a/opted-out-2', optedOutId)).requirePlanApproval).toBe(false);
    expect((await getRepoPolicy('a/still-gated', gatedId)).requirePlanApproval).toBe(true);
  });

  // C2: the read must be scoped to an installation the same way the write
  // is. Two different installations legitimately holding a row for the
  // identical repo string is exactly what the schema's (installationId,
  // repo) unique index permits (see settings-actions.ts) — before this fix,
  // getRepoPolicy's unscoped `WHERE repo = ?` meant whichever row happened
  // to match first (installation churn / insertion order) could ungate a
  // dispatch that should have been reading a DIFFERENT installation's gated
  // row. Reverting the join/installationId filter back to a bare
  // `eq(githubInstallationRepos.repo, repoFullName)` makes this fail: it
  // would nondeterministically return the OTHER installation's policy.
  it('does not leak another installation\'s policy for the identical repo string', async () => {
    const repo = 'shared-name/shared-name';
    const now = new Date();

    const gatedInstallationRowId = 'ghi_shared_gated';
    const gatedInstallationId = 111111;
    await db.insert(schema.githubInstallations).values({
      id: gatedInstallationRowId,
      userId: 'user_gated_owner',
      installationId: gatedInstallationId,
      accountLogin: 'gated-owner',
      accountType: 'Organization',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.githubInstallationRepos).values({
      id: 'ghr_shared_gated',
      installationId: gatedInstallationRowId,
      repo,
      repoPolicy: { requirePlanApproval: true },
      createdAt: now,
    });

    const ungatedInstallationRowId = 'ghi_shared_ungated';
    const ungatedInstallationId = 222222;
    await db.insert(schema.githubInstallations).values({
      id: ungatedInstallationRowId,
      userId: 'user_ungated_owner',
      installationId: ungatedInstallationId,
      accountLogin: 'ungated-owner',
      accountType: 'Organization',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.githubInstallationRepos).values({
      id: 'ghr_shared_ungated',
      installationId: ungatedInstallationRowId,
      repo,
      repoPolicy: { requirePlanApproval: false },
      createdAt: now,
    });

    // Asking on behalf of the GATED installation must never see the
    // UNGATED installation's row for the identical repo string, and vice
    // versa.
    expect((await getRepoPolicy(repo, gatedInstallationId)).requirePlanApproval).toBe(true);
    expect((await getRepoPolicy(repo, ungatedInstallationId)).requirePlanApproval).toBe(false);
  });
});

describe('getRepoPolicyForUser', () => {
  /** Installation + repo row owned by `userId`. */
  async function insertOwnRepoRow(userId: string, installationRowId: string, repo: string, policy: unknown) {
    const now = new Date();
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
      id: `ghr_${installationRowId}`,
      installationId: installationRowId,
      repo,
      repoPolicy: policy as never,
      createdAt: now,
    });
  }

  it("reads the policy from the calling user's own installation", async () => {
    await insertOwnRepoRow('user_a', 'ghi_user_a_own', 'a/b', { requirePlanApproval: false });
    const policy = await getRepoPolicyForUser('a/b', 'user_a');
    expect(policy.requirePlanApproval).toBe(false);
  });

  // The repo Settings page's own read — mirrors the same scoping mistake C2
  // fixed for the webhook path. Reverting getRepoPolicyForUser back to an
  // unscoped `eq(githubInstallationRepos.repo, repoFullName)` (dropping the
  // `eq(githubInstallations.userId, userId)` condition) makes this fail: a
  // user viewing their OWN (gated) repo would see someone else's ungated
  // policy for the identical repo string instead.
  it("never picks up a DIFFERENT user's installation policy for the identical repo string", async () => {
    const repo = 'shared-name/user-scoped';
    await insertOwnRepoRow('user_gated', 'ghi_user_gated', repo, { requirePlanApproval: true });
    await insertOwnRepoRow('user_ungated', 'ghi_user_ungated', repo, { requirePlanApproval: false });

    expect((await getRepoPolicyForUser(repo, 'user_gated')).requirePlanApproval).toBe(true);
    expect((await getRepoPolicyForUser(repo, 'user_ungated')).requirePlanApproval).toBe(false);
  });

  it('gates a repo the user has no installation covering at all', async () => {
    const policy = await getRepoPolicyForUser('nobody/here', 'user_with_nothing');
    expect(policy).toEqual(DEFAULT_REPO_POLICY);
  });
});

describe('getOnboardingInfoForUser', () => {
  async function insertOwnOnboardingRow(
    userId: string,
    installationRowId: string,
    repo: string,
    onboarding: { onboardingState: 'pending_onboarding' | 'active'; onboardingPrUrl?: string | null },
  ) {
    const now = new Date();
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
      id: `ghr_${installationRowId}`,
      installationId: installationRowId,
      repo,
      onboardingState: onboarding.onboardingState,
      onboardingPrUrl: onboarding.onboardingPrUrl ?? null,
      createdAt: now,
    });
  }

  it("reads the onboarding state and PR link from the calling user's own installation", async () => {
    await insertOwnOnboardingRow('user_onboard', 'ghi_user_onboard', 'a/onboard', {
      onboardingState: 'pending_onboarding',
      onboardingPrUrl: 'https://github.com/a/onboard/pull/1',
    });

    const info = await getOnboardingInfoForUser('a/onboard', 'user_onboard');

    expect(info?.onboardingState).toBe('pending_onboarding');
    expect(info?.onboardingPrUrl).toBe('https://github.com/a/onboard/pull/1');
  });

  it("never picks up a DIFFERENT user's onboarding row for the identical repo string", async () => {
    // Same scoping rule as getRepoPolicyForUser (C2) — repo is not a unique
    // key on its own.
    const repo = 'shared-name/onboard-scoped';
    await insertOwnOnboardingRow('user_active', 'ghi_active', repo, { onboardingState: 'active' });
    await insertOwnOnboardingRow('user_pending', 'ghi_pending', repo, {
      onboardingState: 'pending_onboarding',
    });

    expect((await getOnboardingInfoForUser(repo, 'user_active'))?.onboardingState).toBe('active');
    expect((await getOnboardingInfoForUser(repo, 'user_pending'))?.onboardingState).toBe(
      'pending_onboarding',
    );
  });

  it('returns null for a repo the user has no installation covering at all', async () => {
    expect(await getOnboardingInfoForUser('nobody/here', 'user_with_nothing')).toBeNull();
  });
});
