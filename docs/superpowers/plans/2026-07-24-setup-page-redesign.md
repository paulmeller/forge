# /setup Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/setup`'s 3-separate-screen wizard with a single-page checklist (Install / Select repos / Try it), and replace the free-text repo entry with a real GitHub-backed checkbox picker that can both connect and disconnect repos.

**Architecture:** A new `syncRepos` server action (replacing the insert-only `connectRepos`) diffs the submitted checked-state against the DB and inserts/deletes accordingly. The page fetches the installation's actual accessible repos live from GitHub (reusing `createInstallationAccessToken`/`listInstallationRepositories`, already used elsewhere for exactly this) and renders a new `RepoPicker` client component; the Install and Try-it checklist items are static, so they stay as inline JSX in `page.tsx` rather than becoming their own files.

**Tech Stack:** Next.js Server Components + one client component, Drizzle/libSQL, Vitest (real throwaway-DB integration tests, matching this app's established convention for insert/delete-shaped logic).

## Global Constraints

- `syncRepos(installationId: string, selectedRepos: string[])` replaces `connectRepos` entirely — `apps/web/src/app/(app)/setup/repo-selector.tsx` and the old `connectRepos` function are deleted, not kept alongside the new code.
- Disconnecting a repo (unchecking) only deletes its `githubInstallationRepos` row — no cascade to missions/tasks, no active-mission warning.
- If the GitHub API call fails (or `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` aren't configured), the picker falls back to showing only already-connected repos, with an inline note — never an unhandled page error.
- Full-width `PageShell`/`PageHeader` (title "Get set up"), matching `/home`/`/missions`/`/repos`.
- No changes to `github-app-auth.ts`, `github-installation-sync.ts`, or the GitHub App install link/redirect itself.

---

## Task 1: `syncRepos` server action

**Files:**
- Modify: `apps/web/src/app/(app)/setup/actions.ts`
- Test: `apps/web/src/app/(app)/setup/actions.test.ts`

**Interfaces:**
- Produces: `syncRepos(installationId: string, selectedRepos: string[]): Promise<{ error?: string } | undefined>`, exported from `./actions`. Task 2's `RepoPicker` imports this by name.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/app/(app)/setup/actions.test.ts`:

```ts
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

async function insertInstallation(id: string, userId: string) {
  const now = new Date();
  await db.insert(schema.githubInstallations).values({
    id,
    userId,
    installationId: 12345,
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
```

- [ ] **Step 2: Verify the migrations path resolves correctly before running anything**

Run: `node -e "console.log(require('path').resolve('apps/web/src/app/(app)/setup', '../../../../../../packages/db/migrations'))"`
Expected output: an absolute path ending in `packages/db/migrations` that actually exists on disk (confirm with `ls` on the printed path). If it doesn't match, adjust the `../` count in the test file's `resolve(__dirname, ...)` call — this file lives 6 directories below the repo root (`setup` → `(app)` → `app` → `src` → `web` → `apps` → root), so 6 `../` segments is correct; get this wrong and every test in the file fails with a confusing migration error, not a clear "wrong path" error.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/app/\(app\)/setup/actions.test.ts`
Expected: FAIL — `syncRepos` is not exported from `./actions` yet (only the old `connectRepos` exists).

- [ ] **Step 4: Replace `connectRepos` with `syncRepos`**

Replace the full content of `apps/web/src/app/(app)/setup/actions.ts` with:

```ts
'use server';

import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

export async function syncRepos(
  installationId: string,
  selectedRepos: string[],
): Promise<{ error?: string } | undefined> {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  if (!installation || installation.userId !== user.id) {
    return { error: 'Installation not found' };
  }

  const existing = await db
    .select()
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.installationId, installationId));
  const existingRepoNames = new Set(existing.map((r) => r.repo));
  const selectedSet = new Set(selectedRepos);

  const toAdd = selectedRepos.filter((r) => !existingRepoNames.has(r));
  const toRemove = existing.filter((r) => !selectedSet.has(r.repo));

  for (const repo of toAdd) {
    const id = `ghr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.insert(githubInstallationRepos).values({ id, installationId, repo }).onConflictDoNothing();
  }
  for (const row of toRemove) {
    await db.delete(githubInstallationRepos).where(eq(githubInstallationRepos.id, row.id));
  }

  return undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/app/\(app\)/setup/actions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: FAIL at this point — `apps/web/src/app/(app)/setup/repo-selector.tsx` still imports and calls `connectRepos`, which no longer exists. This is expected; Task 2 deletes that file. Confirm the *only* typecheck error is in `repo-selector.tsx` (or its callers) — if there are other unrelated errors, stop and investigate before proceeding, since Task 2 assumes this is the sole breakage.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(app\)/setup/actions.ts apps/web/src/app/\(app\)/setup/actions.test.ts
git commit -m "feat(web): replace connectRepos with syncRepos (add + remove)"
```

Note: this commit leaves the repo temporarily non-typechecking (per Step 6) because `repo-selector.tsx` still references the now-deleted `connectRepos`. This is expected and resolved by Task 2 in the same work session — do not attempt to make Task 1 typecheck-clean in isolation, since `repo-selector.tsx` itself is being deleted, not patched.

---

## Task 2: Single-page checklist + `RepoPicker`

**Files:**
- Modify: `apps/web/src/app/(app)/setup/page.tsx`
- Create: `apps/web/src/app/(app)/setup/repo-picker.tsx`
- Delete: `apps/web/src/app/(app)/setup/repo-selector.tsx`

**Interfaces:**
- Consumes: `syncRepos` from Task 1's `./actions`. `createInstallationAccessToken(installationId: number, appId: string, privateKeyPem: string): Promise<string>` and `listInstallationRepositories(installationToken: string): Promise<string[]>` from `@/lib/github-app-auth` (both pre-existing, unchanged). `env.GITHUB_APP_ID`, `env.GITHUB_APP_PRIVATE_KEY`, `env.GITHUB_APP_SLUG` from `@/lib/env` (all pre-existing).
- Produces: `RepoPicker({ installationId: string; ghRepos: string[] | null; connectedRepos: string[] })`, a client component exported from the new `./repo-picker`.

- [ ] **Step 1: Delete the old repo selector**

```bash
git rm apps/web/src/app/\(app\)/setup/repo-selector.tsx
```

- [ ] **Step 2: Create `repo-picker.tsx`**

Create `apps/web/src/app/(app)/setup/repo-picker.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';

import { syncRepos } from './actions';

export function RepoPicker({
  installationId,
  ghRepos,
  connectedRepos,
}: {
  installationId: string;
  ghRepos: string[] | null;
  connectedRepos: string[];
}) {
  const router = useRouter();
  const availableRepos = ghRepos ?? connectedRepos;
  const [checked, setChecked] = useState<Set<string>>(new Set(connectedRepos));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  function toggle(repo: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  async function handleSave() {
    setError('');
    setPending(true);
    const result = await syncRepos(installationId, [...checked]);
    if (result?.error) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.refresh();
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {ghRepos === null && (
        <p className="text-xs text-muted-foreground">
          Couldn&rsquo;t reach GitHub to list new repos right now — showing already-connected repos
          only. Try again shortly to add more.
        </p>
      )}
      {availableRepos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repos available. Check the GitHub App&rsquo;s repository access settings.
        </p>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {availableRepos.map((repo) => (
            <label key={repo} className="flex items-center gap-2 text-sm">
              <Checkbox checked={checked.has(repo)} onCheckedChange={() => toggle(repo)} />
              <span className="font-mono">{repo}</span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button onClick={handleSave} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Save selection ({checked.size} selected)
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `page.tsx`**

Replace the full content of `apps/web/src/app/(app)/setup/page.tsx` with:

```tsx
import Link from 'next/link';
import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { PageHeader, PageShell } from '@/components/page-shell';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { createInstallationAccessToken, listInstallationRepositories } from '@/lib/github-app-auth';
import { withAuth } from '@/lib/with-auth';

import { RepoPicker } from './repo-picker';

export default async function SetupPage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id));

  let ghRepos: string[] | null = null;
  let connectedRepos: string[] = [];

  if (installation) {
    const rows = await db
      .select()
      .from(githubInstallationRepos)
      .where(eq(githubInstallationRepos.installationId, installation.id));
    connectedRepos = rows.map((r) => r.repo);

    // Same env vars and guard github-installation-sync.ts already uses for
    // this exact create-token-then-list-repos flow — wrapped in try/catch
    // here (unlike that file) so a failure degrades the page gracefully
    // instead of throwing.
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const token = await createInstallationAccessToken(
          installation.installationId,
          env.GITHUB_APP_ID,
          env.GITHUB_APP_PRIVATE_KEY,
        );
        ghRepos = await listInstallationRepositories(token);
      } catch {
        ghRepos = null;
      }
    }
  }

  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />

      <div className="flex flex-col gap-4">
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {installation ? (
                  <span className="text-live">&#10003;</span>
                ) : (
                  <span className="text-muted-foreground">1.</span>
                )}{' '}
                Install the Forge GitHub App
              </p>
              {installation && (
                <p className="mt-1 text-xs text-muted-foreground">{installation.accountLogin}</p>
              )}
            </div>
            {!installation && (
              <a
                href={`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`}
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Install on GitHub
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border p-4 ${!installation ? 'opacity-40' : ''}`}>
          <p className="mb-3 text-sm font-medium">2. Select repos</p>
          {installation ? (
            <RepoPicker
              installationId={installation.id}
              ghRepos={ghRepos}
              connectedRepos={connectedRepos}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Complete step 1 first.</p>
          )}
        </div>

        <div className={`rounded-lg border p-4 ${connectedRepos.length === 0 ? 'opacity-40' : ''}`}>
          <p className="text-sm font-medium">3. Try it</p>
          {connectedRepos.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Comment <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue in a
              connected repo, or{' '}
              <Link href="/missions/new" className="underline hover:text-foreground">
                start a mission manually
              </Link>
              .
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Select at least one repo first.</p>
          )}
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS — this resolves the expected-failure noted at the end of Task 1 (the deleted `repo-selector.tsx` no longer exists to reference the removed `connectRepos`).

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm -r test`
Expected: PASS — every existing test still green, plus Task 1's 7 new tests.

- [ ] **Step 6: Manual verification (dev server) — required, not optional**

This is a full page redesign with live GitHub API calls that nothing in the automated test suite exercises end-to-end. Run:

```bash
cd apps/web && pnpm dev
```

Sign in and visit `/setup`. Confirm:
1. With no GitHub App installation: step 1 shows the install button, steps 2 and 3 appear locked/dimmed.
2. With an installation and zero connected repos: step 1 shows done + the account login, step 2 shows the checkbox picker (checked state reflecting whatever's already connected, likely none), step 3 is locked.
3. Check a repo, click "Save selection", confirm the page refreshes and that repo now shows checked and step 3 unlocks.
4. Uncheck a previously-connected repo, save, confirm it's actually removed (re-visit the page and confirm it comes back unchecked, not just visually toggled).
5. If you can't easily test a live GitHub API failure, at least confirm the code path exists by reading it back rather than skipping verification silently — note in your report whether you tested the fallback state (missing/invalid `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`) or only the happy path, and why.

If your sandboxed environment cannot reach a real authenticated session or a real GitHub App installation, do not claim full visual/functional confirmation — verify what you concretely can (dev server starts cleanly, typecheck/tests pass, route responds without a server error) and state plainly in your report which parts of this checklist were and weren't actually exercised.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(app\)/setup/page.tsx apps/web/src/app/\(app\)/setup/repo-picker.tsx
git commit -m "feat(web): redesign /setup as a single-page checklist with a real repo picker"
```

---

## After all tasks: whole-branch review

Once Tasks 1–2 are complete, dispatch a final whole-branch code review (per `superpowers:subagent-driven-development`) covering the full diff. Pay particular attention to:
- Confirm `repo-selector.tsx` is genuinely deleted (not left alongside the new `repo-picker.tsx`) and nothing else in the app still imports it.
- Confirm `installation.installationId` (the numeric GitHub ID) and `installation.id` (the internal text PK) are never swapped — `createInstallationAccessToken` takes the former, `githubInstallationRepos.installationId` and `syncRepos`'s parameter both use the latter.
- Confirm the GitHub API failure path (`ghRepos === null`) genuinely can't throw an unhandled error up through the page — the `try/catch` should be the only thing standing between a GitHub outage and a 500.
