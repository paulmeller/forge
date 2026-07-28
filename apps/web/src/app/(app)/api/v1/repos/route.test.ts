import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-repos-list-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({ apiAuth: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let GET: typeof import('./route').GET;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ GET } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.apiAuth.mockReset();
});

beforeEach(async () => {
  // github_installations cascades to github_installation_repos.
  await db.delete(schema.githubInstallations);
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

/** An installation + covered repo row, owned by `userId`. */
async function seedInstallationRepo(userId: string, installationDbId: string, repo: string) {
  const now = new Date();
  await db.insert(schema.githubInstallations).values({
    id: installationDbId,
    userId,
    installationId: Math.floor(Math.random() * 1_000_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${installationDbId}_${repo.replaceAll('/', '_')}`,
    installationId: installationDbId,
    repo,
    repoPolicy: null,
    createdAt: now,
  });
}

describe('GET /api/v1/repos', () => {
  it("lists only the caller's own repos, sorted", async () => {
    await seedInstallationRepo('u1', 'ghi_u1', 'acme/one');
    await seedInstallationRepo('u1', 'ghi_u1b', 'acme/two');
    authAs('u1');

    const res = await GET(new Request('http://x'), {});

    expect(res.status).toBe(200);
    expect((await res.json()).repos).toEqual(['acme/one', 'acme/two']);
  });

  // Both directions of the installation-scoping predicate, per Task 7's own
  // warning: a single "rejects" case does not pin polarity — an inverted
  // filter can pass a check that only ever asserts absence.
  it("never lists another user's repos, even for a repo name the caller also happens to cover", async () => {
    await seedInstallationRepo('u1', 'ghi_u1', 'acme/mine');
    await seedInstallationRepo('victim', 'ghi_victim', 'acme/victim-only');
    authAs('u1');

    const res = await GET(new Request('http://x'), {});
    const body = (await res.json()) as { repos: string[] };

    expect(body.repos).toContain('acme/mine');
    expect(body.repos).not.toContain('acme/victim-only');
  });

  it('returns an empty list for a caller with no installations', async () => {
    authAs('u_no_installs');

    const res = await GET(new Request('http://x'), {});

    expect(res.status).toBe(200);
    expect((await res.json()).repos).toEqual([]);
  });
});
