import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  createInstallationAccessToken: vi.fn(),
  listInstallationRepositories: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('@/lib/github-app-auth', () => ({
  createInstallationAccessToken: mocks.createInstallationAccessToken,
  listInstallationRepositories: mocks.listInstallationRepositories,
}));

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported
// (mirrors the pattern used by apps/web/src/app/(app)/api/chat/route.test.ts
// and apps/web/src/server/tick/reconciler-pr.test.ts).
const DB_FILE = `/tmp/forge-setup-actions-${process.pid}.db`;
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

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ syncRepos } = await import('./actions'));
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

let installationCounter = 12345;

async function insertInstallation(id: string, userId: string) {
  const now = new Date();
  await db.insert(schema.githubInstallations).values({
    id,
    userId,
    installationId: installationCounter++,
    accountLogin: 'acme-org',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
}

async function insertRepo(id: string, installationId: string, repo: string) {
  await db.insert(schema.githubInstallationRepos).values({ id, installationId, repo, createdAt: new Date() });
}

async function connectedRepos(installationId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.githubInstallationRepos)
    .where(eq(schema.githubInstallationRepos.installationId, installationId));
  return rows.map((r) => r.repo).sort();
}

/**
 * Stubs the create-token-then-list-repos round trip syncRepos now makes to
 * verify a selection against GitHub before writing it — the same two calls
 * setup/page.tsx makes to build the picker (github-app-auth.ts). `repos` is
 * what GitHub reports this installation may actually reach.
 */
function mockGithubGrants(repos: string[]): void {
  mocks.createInstallationAccessToken.mockResolvedValueOnce('fake-installation-token');
  mocks.listInstallationRepositories.mockResolvedValueOnce(repos);
}

describe('syncRepos', () => {
  it('adds newly-selected repos not already connected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_add', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_add');
    mockGithubGrants(['acme/api', 'acme/widgets']);

    const result = await syncRepos(instId, ['acme/api', 'acme/widgets']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api', 'acme/widgets']);

    // Connecting a repo does not authorise dispatch (#40) — every newly
    // written row starts pending_onboarding, not active.
    const rows = await db
      .select()
      .from(schema.githubInstallationRepos)
      .where(eq(schema.githubInstallationRepos.installationId, instId));
    expect(rows.every((r) => r.onboardingState === 'pending_onboarding')).toBe(true);
  });

  it('removes previously-connected repos that are no longer selected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_remove', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_remove');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/api');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/legacy');
    mockGithubGrants(['acme/api']);

    const result = await syncRepos(instId, ['acme/api']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api']);
  });

  it('adds and removes in the same call', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_mix', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_mix');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/legacy');
    mockGithubGrants(['acme/api', 'acme/widgets']);

    const result = await syncRepos(instId, ['acme/api', 'acme/widgets']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api', 'acme/widgets']);
  });

  it('is a no-op when the selected set exactly matches what is already connected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_noop', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_noop');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/api');
    mockGithubGrants(['acme/api']);

    const result = await syncRepos(instId, ['acme/api']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api']);
  });

  it('returns an error when the installation does not belong to the authenticated user', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_attacker', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_owner');

    const result = await syncRepos(instId, ['acme/api']);

    expect(result).toEqual({ error: 'Installation not found' });
    expect(await connectedRepos(instId)).toEqual([]);
  });

  it('returns an error when the installation does not exist', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_x', name: 'A', email: 'a@x.com' });

    const result = await syncRepos('inst_does_not_exist', ['acme/api']);

    expect(result).toEqual({ error: 'Installation not found' });
  });

  it('rejects a repo the installation genuinely owns is mixed in with one GitHub does not grant, and writes nothing', async () => {
    // The core of the bypass this closes: the caller owns this installation
    // for real (the ownership check above passes) but is naming a repo
    // GitHub never granted it. Mixed with a real repo in the same call, to
    // prove rejection is atomic — the legitimate repo must not be written
    // either.
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_overreach', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_overreach');
    mockGithubGrants(['acme/api']); // GitHub grants only acme/api

    const result = await syncRepos(instId, ['acme/api', 'victim-org/victim-repo']);

    expect(result).toEqual({ error: 'Installation does not grant access to: victim-org/victim-repo' });
    expect(await connectedRepos(instId)).toEqual([]);
  });

  it('fails closed (rejects, does not write) when the GitHub App is not configured', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_noapp', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_noapp');
    const prevId = process.env.GITHUB_APP_ID;
    const prevKey = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    try {
      const result = await syncRepos(instId, ['acme/api']);
      expect(result).toEqual({
        error: 'GitHub App is not configured on the server — cannot verify repo access',
      });
      expect(await connectedRepos(instId)).toEqual([]);
      expect(mocks.listInstallationRepositories).not.toHaveBeenCalled();
    } finally {
      process.env.GITHUB_APP_ID = prevId;
      process.env.GITHUB_APP_PRIVATE_KEY = prevKey;
    }
  });

  it('fails closed (rejects, does not write, does not trust the client list) when the GitHub call errors', async () => {
    // Named distinctly from every other test here: this is the one a
    // "catch and fall back to selectedRepos" mutant must break, and no other
    // test in this file may incidentally cover the same path.
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_ghdown', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_ghdown');
    mocks.createInstallationAccessToken.mockRejectedValueOnce(new Error('GitHub is down'));

    const result = await syncRepos(instId, ['acme/api']);

    expect(result).toEqual({ error: 'Could not verify repo access with GitHub — try again' });
    expect(await connectedRepos(instId)).toEqual([]);
  });
});
