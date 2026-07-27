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
let DEFAULT_REPO_POLICY: typeof import('./repo-policy').DEFAULT_REPO_POLICY;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ getRepoPolicy, DEFAULT_REPO_POLICY } = await import('./repo-policy'));
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

/** Inserts a github_installation_repos row with an arbitrary (possibly malformed) policy value. */
async function insertRepoRow(repo: string, policy: unknown) {
  const now = new Date();
  const installationId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.githubInstallations).values({
    id: installationId,
    userId: 'user_test',
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId,
    repo,
    // Bypass the RepoPolicy type on purpose — the whole point of these tests
    // is to see what getRepoPolicy does with data that shouldn't exist but
    // might (e.g. hand-edited rows, a future writer with a bug).
    repoPolicy: policy as never,
    createdAt: now,
  });
}

describe('getRepoPolicy', () => {
  it('gates (requirePlanApproval: true) a repo with no row at all', async () => {
    const policy = await getRepoPolicy('nobody/here');
    expect(policy).toEqual(DEFAULT_REPO_POLICY);
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('gates a repo with a row but no policy column set', async () => {
    await insertRepoRow('a/no-policy', null);
    const policy = await getRepoPolicy('a/no-policy');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('gates a repo whose policy is an empty object', async () => {
    await insertRepoRow('a/empty-policy', {});
    const policy = await getRepoPolicy('a/empty-policy');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('ungates only on an explicit requirePlanApproval: false', async () => {
    await insertRepoRow('a/opted-out', { requirePlanApproval: false });
    const policy = await getRepoPolicy('a/opted-out');
    expect(policy.requirePlanApproval).toBe(false);
  });

  it('fails closed when requirePlanApproval is null (malformed data)', async () => {
    await insertRepoRow('a/malformed-null', { requirePlanApproval: null });
    const policy = await getRepoPolicy('a/malformed-null');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is 0 (malformed data)', async () => {
    await insertRepoRow('a/malformed-zero', { requirePlanApproval: 0 });
    const policy = await getRepoPolicy('a/malformed-zero');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is an empty string (malformed data)', async () => {
    await insertRepoRow('a/malformed-string', { requirePlanApproval: '' });
    const policy = await getRepoPolicy('a/malformed-string');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('fails closed when requirePlanApproval is "false" the string, not the boolean (malformed data)', async () => {
    await insertRepoRow('a/malformed-string-false', { requirePlanApproval: 'false' });
    const policy = await getRepoPolicy('a/malformed-string-false');
    expect(policy.requirePlanApproval).toBe(true);
  });

  it('is scoped per repo — one repo opting out does not affect another', async () => {
    await insertRepoRow('a/opted-out-2', { requirePlanApproval: false });
    await insertRepoRow('a/still-gated', { requirePlanApproval: true });
    expect((await getRepoPolicy('a/opted-out-2')).requirePlanApproval).toBe(false);
    expect((await getRepoPolicy('a/still-gated')).requirePlanApproval).toBe(true);
  });
});
