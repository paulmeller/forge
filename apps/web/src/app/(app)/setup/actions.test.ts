import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const mocks = vi.hoisted(() => ({ withAuth: vi.fn() }));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported
// (mirrors the pattern used by apps/web/src/app/(app)/api/chat/route.test.ts
// and apps/web/src/server/tick/reconciler-pr.test.ts).
const DB_FILE = `/tmp/forge-setup-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

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

describe('syncRepos', () => {
  it('adds newly-selected repos not already connected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_add', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_add');

    const result = await syncRepos(instId, ['acme/api', 'acme/widgets']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api', 'acme/widgets']);
  });

  it('removes previously-connected repos that are no longer selected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_remove', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_remove');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/api');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/legacy');

    const result = await syncRepos(instId, ['acme/api']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api']);
  });

  it('adds and removes in the same call', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_mix', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_mix');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/legacy');

    const result = await syncRepos(instId, ['acme/api', 'acme/widgets']);

    expect(result).toBeUndefined();
    expect(await connectedRepos(instId)).toEqual(['acme/api', 'acme/widgets']);
  });

  it('is a no-op when the selected set exactly matches what is already connected', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_noop', name: 'A', email: 'a@x.com' });
    const instId = `inst_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertInstallation(instId, 'user_noop');
    await insertRepo(`ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`, instId, 'acme/api');

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
});
