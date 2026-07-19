# Repo Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/repos` and `/repos/[owner]/[repo]` — a per-issue "Work on it" workspace backed by a lazily-created, never-auto-completed "standing" triage Mission per repo, reusing the existing triage pipeline end to end.

**Architecture:** One schema addition (`missions.workspace_repo`) plus one server-only module (`workspace-mission.ts`) that gets-or-creates the standing Mission and reuses `buildTriageTaskRows` to enqueue a single issue. The reconciler gets a one-line exemption so standing missions never auto-complete. The UI is two new server-component pages that reuse existing pieces verbatim: `listUserRepos` (composer), `githubSearchIssues` (triage planner), `groupTasksByIssue`/`headlineFor` (triage-view), and `IssueTriageCard` (mission issues page) — no new stage-tab UI, no new pill vocabulary.

**Tech Stack:** Next.js 15 App Router, React 19 (server components + one client button), drizzle + libSQL, zod, vitest.

## Global Constraints

- "Work on it" dispatches immediately — no staging batch, no plan-review gate.
- Issue list shows ALL open issues, newest first, with client-side search + label filter chips (no server-side pre-filtering to `label:bug`).
- Curation is per-issue opt-in — the workspace never bulk-enqueues from a query.
- The standing Mission is a real `missions` row: same budgets/guardrails/Ledger as any Mission, visible at `/missions/<id>`.
- No new pill vocabulary and no new stage-tab UI — reuse `TriageHeadline`/`groupTasksByIssue`/`headlineFor` (`apps/web/src/lib/triage-view.ts`) and `IssueTriageCard` (`apps/web/src/components/issue-triage-card.tsx`) exactly as they exist today.
- Reconciler must never auto-complete a mission with `workspaceRepo` set — budgets, guardrails, and task-level reconciliation still apply to it.
- Missing `GITHUB_APP_TOKEN` → a guidance empty-state, never a crash or 500.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.
- Spec: `docs/superpowers/specs/2026-07-15-repo-workspace-design.md`.

---

### Task 1: Schema — `workspace_repo` column + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (the `missions` table, ~line 83-127)
- Create: `packages/db/migrations/00XX_workspace_repo.sql` (generated, see Step 2)

**Interfaces:**
- Produces: `missions.workspaceRepo: string | null` on the `Mission`/`NewMission` inferred types.

- [ ] **Step 1: Add the column**

In `packages/db/src/schema.ts`, inside the `missions` table definition, add one field. Insert it right after the `issueQuery` field (after its closing comment block, before `concurrencyCap`):

```ts
  /**
   * Set only for a repo's "standing" workspace Mission (one per user+repo,
   * created lazily by the Repo Workspace's "Work on it" action). Null for
   * ordinary composer-authored missions. The reconciler must never
   * auto-complete a mission with this set — see reconciler.ts.
   */
  workspaceRepo: text('workspace_repo'),
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:generate`

This repo's migration-snapshot chain has known gaps (migrations 0004/0005/0008 were hand-written without matching drizzle snapshots), so `db:generate` may emit spurious `ALTER TABLE` statements for columns that already exist elsewhere. Open the generated file in `packages/db/migrations/` and keep ONLY the statement(s) that add `workspace_repo` to `missions`. If it emits anything else, delete those lines. The file should end up looking like:

```sql
ALTER TABLE `missions` ADD `workspace_repo` text;
```

- [ ] **Step 3: Apply and verify**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:migrate`
Expected: `done`, no errors.

Run: `sqlite3 packages/db/local.db ".schema missions" | grep workspace_repo`
Expected: one line showing the new column.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @forge/db typecheck && pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
git add packages/db/src/schema.ts packages/db/migrations/
git commit -m "feat(workspace): add missions.workspace_repo column"
```

---

### Task 2: Reconciler exemption for standing missions

**Files:**
- Modify: `apps/tick/src/reconciler.ts` (the mission-completion candidate query, ~line 299)
- Test: `apps/tick/src/reconciler.test.ts` (create if it doesn't already exist — check first: `ls apps/tick/src/reconciler.test.ts`)

**Interfaces:**
- Consumes: `missions.workspaceRepo` (Task 1).
- Produces: no behavior change for `workspaceRepo === null` missions; missions with `workspaceRepo` set are never selected as completion candidates regardless of task state.

- [ ] **Step 1: Check for an existing reconciler test file and its patterns**

Run: `ls apps/tick/src/reconciler.test.ts 2>&1` and, if it exists, `grep -n "describe\|runReconciler\|missions).values" apps/tick/src/reconciler.test.ts | head -30` to match its existing DB-seeding helpers exactly (same insert shape for `missions`/`tasks`). If no such file exists, look at a sibling tick test (`apps/tick/src/*.test.ts`) for the DB setup pattern used in this package (in-memory libSQL, direct `db.insert`, etc.) and follow it — report back with what you found before writing new tests if the pattern is unclear.

- [ ] **Step 2: Add the exemption**

In `apps/tick/src/reconciler.ts`, change the candidate query (currently `and eq(missions.status, 'running')`— read the exact current line before editing since line numbers may have shifted from Task 1's schema edit) to also require `workspaceRepo` to be null:

```ts
  const candidates = await db
    .select()
    .from(missions)
    .where(and(eq(missions.status, 'running'), isNull(missions.workspaceRepo)));
```

`isNull` is already imported in this file (check the top-level `drizzle-orm` import list — if `isNull` isn't there, add it to the existing `import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';` line; it may already be present since `isNull` appears used elsewhere in the file for gate-stall detection — verify by reading the full file once).

- [ ] **Step 3: Write a regression test**

Add to `apps/tick/src/reconciler.test.ts` (following whatever DB-seeding helper pattern you found in Step 1) a test asserting: a mission with `workspaceRepo: 'acme/api'`, `status: 'running'`, and all its tasks in terminal states is NOT completed by `runReconciler` (its status stays `'running'` after the call), while an otherwise-identical mission with `workspaceRepo: null` IS completed. Two missions, one assertion each, one `runReconciler` call covering both (mirrors "candidates" being evaluated together in one pass).

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @forge/tick test -- reconciler`
Expected: new test(s) pass; no regressions in existing reconciler tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/tick typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/tick/src/reconciler.ts apps/tick/src/reconciler.test.ts
git commit -m "fix(workspace): exempt standing missions from auto-completion"
```

---

### Task 3: `workspace-mission.ts` — get-or-create the standing Mission

**Files:**
- Create: `apps/web/src/lib/workspace-mission.ts`
- Test: `apps/web/src/lib/workspace-mission.test.ts`

**Interfaces:**
- Consumes: `type MissionDefaults` from `@/lib/mission-defaults` (already on the branch — the composer's default-resolution helper); `type Mission, type NewMission` from `@forge/db`.
- Produces:
  ```ts
  export type WorkspaceMissionDeps = {
    findExisting: (userId: string, repo: string) => Promise<Mission | null>;
    insertMission: (values: NewMission) => Promise<Mission>;
  };
  export async function getOrCreateWorkspaceMission(
    userId: string,
    repo: string,
    defaults: MissionDefaults,
    deps?: WorkspaceMissionDeps,
  ): Promise<Mission>;
  ```
  Default `deps` hit the real `db` (exported separately as `dbFindExistingWorkspaceMission`/`dbInsertMission` so Task 4's server action can reuse the same default wiring without re-deriving it — but tests always pass explicit fakes).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/workspace-mission.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { Mission, NewMission } from '@forge/db';

import type { MissionDefaults } from './mission-defaults';
import { getOrCreateWorkspaceMission } from './workspace-mission';

const defaults: MissionDefaults = {
  agentId: 'agent_abc',
  githubInstallationId: '123',
  githubVaultId: 'vault_abc',
  source: 'setup',
};

function fakeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_existing',
    userId: 'usr_1',
    name: 'Issues — acme/api',
    goal: 'Triage open issues in acme/api',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_abc',
    plannerStrategy: 'triage',
    targetRepos: ['acme/api'],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    spentUsd: 0,
    spentTokens: 0,
    autoMergePolicy: null,
    webhookSecret: 'secret',
    githubInstallationId: '123',
    githubVaultId: 'vault_abc',
    skillId: null,
    aiReviewEnabled: false,
    budgetHardStopPct: 100,
    taskMaxTokens: null,
    taskMaxTurns: null,
    noProgressTokens: null,
    selfVerifyEnabled: false,
    workspaceRepo: 'acme/api',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    ...over,
  } as Mission;
}

describe('getOrCreateWorkspaceMission', () => {
  it('returns the existing mission without inserting when one is found', async () => {
    const existing = fakeMission();
    const findExisting = vi.fn().mockResolvedValue(existing);
    const insertMission = vi.fn();

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(existing);
    expect(findExisting).toHaveBeenCalledWith('usr_1', 'acme/api');
    expect(insertMission).not.toHaveBeenCalled();
  });

  it('inserts a new running mission scoped to the repo when none exists', async () => {
    const inserted = fakeMission({ id: 'msn_new' });
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(inserted);
    expect(insertMission).toHaveBeenCalledTimes(1);
    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.workspaceRepo).toBe('acme/api');
    expect(values.targetRepos).toEqual(['acme/api']);
    expect(values.plannerStrategy).toBe('triage');
    expect(values.status).toBe('running');
    expect(values.agentId).toBe('agent_abc');
    expect(values.githubInstallationId).toBe('123');
    expect(values.githubVaultId).toBe('vault_abc');
    expect(values.budgetUsd).toBeNull();
    expect(values.name).toBe('Issues — acme/api');
    expect(values.goal).toContain('acme/api');
  });

  it('propagates a null agentId from defaults rather than inventing one', async () => {
    const noAgentDefaults: MissionDefaults = { ...defaults, agentId: null, source: 'none' };
    const inserted = fakeMission({ agentId: '' });
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    await getOrCreateWorkspaceMission('usr_1', 'acme/api', noAgentDefaults, {
      findExisting,
      insertMission,
    });

    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.agentId).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- workspace-mission`
Expected: FAIL — cannot resolve `./workspace-mission`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/workspace-mission.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';

import { missions, type Mission, type NewMission } from '@forge/db';

import { db } from './db';
import type { MissionDefaults } from './mission-defaults';

export type WorkspaceMissionDeps = {
  findExisting: (userId: string, repo: string) => Promise<Mission | null>;
  insertMission: (values: NewMission) => Promise<Mission>;
};

async function dbFindExisting(userId: string, repo: string): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        eq(missions.workspaceRepo, repo),
        notInArray(missions.status, ['completed', 'cancelled']),
      ),
    )
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row ?? null;
}

async function dbInsertMission(values: NewMission): Promise<Mission> {
  const [created] = await db.insert(missions).values(values).returning();
  if (!created) throw new Error('workspace mission insert returned no rows');
  return created;
}

const defaultDeps: WorkspaceMissionDeps = {
  findExisting: dbFindExisting,
  insertMission: dbInsertMission,
};

/**
 * Get the repo's standing triage Mission for this user, creating it if none
 * exists. Standing missions start `running` immediately — there is no
 * draft/plan phase; per-issue "Work on it" opt-in replaces plan review. The
 * reconciler must never auto-complete a mission with `workspaceRepo` set
 * (see apps/tick/src/reconciler.ts).
 */
export async function getOrCreateWorkspaceMission(
  userId: string,
  repo: string,
  defaults: MissionDefaults,
  deps: WorkspaceMissionDeps = defaultDeps,
): Promise<Mission> {
  const existing = await deps.findExisting(userId, repo);
  if (existing) return existing;

  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: `Issues — ${repo}`,
    goal: `Triage open issues in ${repo}.`,
    status: 'running',
    backend: 'managed-agents',
    agentId: defaults.agentId ?? '',
    plannerStrategy: 'triage',
    targetRepos: [repo],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    budgetHardStopPct: 100,
    taskMaxTurns: null,
    taskMaxTokens: null,
    noProgressTokens: null,
    webhookSecret: randomBytes(32).toString('hex'),
    githubInstallationId: defaults.githubInstallationId,
    githubVaultId: defaults.githubVaultId,
    skillId: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    workspaceRepo: repo,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };

  return deps.insertMission(values);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- workspace-mission`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. (If `agentId: defaults.agentId ?? ''` mismatches the real `agentId: z.string()...` non-nullable column type, adjust to match whatever `NewMission['agentId']` actually requires — it's `text('agent_id').notNull()`, i.e. `string`, so the `?? ''` coercion above is required and correct.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/workspace-mission.ts apps/web/src/lib/workspace-mission.test.ts
git commit -m "feat(workspace): get-or-create standing triage mission per repo"
```

---

### Task 4: "Work on it" server action

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Consumes: `getOrCreateWorkspaceMission` (Task 3), `resolveMissionDefaults` (existing, `@/lib/mission-defaults-db`), `buildTriageTaskRows` + `type TriageIssue` (existing, exported from `@/lib/triage-planner`), `withAuth` (existing, `@/lib/with-auth`).
- Produces:
  ```ts
  export async function workOnIssue(
    repo: string,
    issue: { number: number; title: string; body: string; url: string },
  ): Promise<{ ok: true } | { ok: false; error: string }>
  ```

- [ ] **Step 1: Write the action**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`:

```ts
'use server';

import { randomUUID } from 'node:crypto';

import { ledgerEvents, tasks } from '@forge/db';

import { db } from '@/lib/db';
import { resolveMissionDefaults } from '@/lib/mission-defaults-db';
import { buildTriageTaskRows, type TriageIssue } from '@/lib/triage-planner';
import { withAuth } from '@/lib/with-auth';
import { getOrCreateWorkspaceMission } from '@/lib/workspace-mission';

/**
 * Enqueue a gated reproduce→fix Task pair for one issue, in the repo's
 * standing triage Mission (created on first use). Dispatches on the next
 * tick — this action only inserts rows.
 */
export async function workOnIssue(
  repo: string,
  issue: { number: number; title: string; body: string; url: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();

  let mission;
  try {
    const defaults = await resolveMissionDefaults(user.id);
    mission = await getOrCreateWorkspaceMission(user.id, repo, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare mission' };
  }

  const triageIssue: TriageIssue = {
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
  };

  const now = new Date();
  const rows = buildTriageTaskRows(mission.id, [triageIssue], now);

  await db.insert(tasks).values(rows);
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'workspace.issue.enqueued',
    payload: { issueRef: `${repo}#${issue.number}`, taskIds: rows.map((r) => r.id) },
    createdAt: now,
  });

  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. (If `ledgerEvents.eventType` is a typed enum that doesn't include `'workspace.issue.enqueued'`, check `packages/db/src/schema.ts` for the `eventType` column definition — if it's a free-form `text()` column, no change needed; if it's a constrained enum, add `'workspace.issue.enqueued'` to that enum in the same file as a one-line addition and regenerate/apply a migration exactly like Task 1's Steps 2-3.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): workOnIssue server action"
```

---

### Task 5: `/repos` — repo list page

**Files:**
- Create: `apps/web/src/app/(app)/repos/page.tsx`

**Interfaces:**
- Consumes: `withAuth` (existing), `listUserRepos` (existing, `@/lib/mission-defaults-db`).

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/(app)/repos/page.tsx`:

```tsx
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const user = await withAuth();
  const repos = await listUserRepos(user.id);

  return (
    <main className="container max-w-3xl py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a repo to see its open issues and work on them one at a time.
        </p>
      </div>

      {repos.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No repos connected yet.{' '}
          <Link href="/setup" className="underline underline-offset-2">
            Connect repos in Setup
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-2">
          {repos.map((repo) => {
            const [owner, name] = repo.split('/');
            return (
              <Link
                key={repo}
                href={`/repos/${owner}/${name}`}
                className="block rounded-lg border p-4 font-mono text-sm transition-colors hover:bg-accent"
              >
                {repo}
              </Link>
            );
          })}
          <Button asChild variant="ghost" size="sm" className="mt-2">
            <Link href="/setup">Connect more repos</Link>
          </Button>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos`
Expected: `307` (auth redirect).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/repos/page.tsx"
git commit -m "feat(workspace): /repos list page"
```

---

### Task 6: Workspace-mission data helper for the issues page

**Files:**
- Create: `apps/web/src/lib/workspace-issues.ts`
- Test: `apps/web/src/lib/workspace-issues.test.ts`

**Interfaces:**
- Consumes: `type TriageIssue` (`@/lib/triage-planner`), `type IssueGroup, groupTasksByIssue` (`@/lib/triage-view`).
- Produces:
  ```ts
  export type WorkspaceIssueRow = {
    issue: TriageIssue;
    group: IssueGroup | null; // null when Forge hasn't touched this issue yet
  };
  export function mergeIssuesWithGroups(
    issues: TriageIssue[],
    groups: IssueGroup[],
  ): WorkspaceIssueRow[];
  ```
  Pure — matches issues to groups by `${repo}#${number}` against `IssueGroup.issueRef`, preserving the input `issues` order (newest-first, as returned by the GitHub search).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/workspace-issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { TriageIssue } from './triage-planner';
import type { IssueGroup } from './triage-view';
import { mergeIssuesWithGroups } from './workspace-issues';

const issue = (over: Partial<TriageIssue> = {}): TriageIssue => ({
  repo: 'acme/api',
  number: 1,
  title: 'Untouched issue',
  body: '',
  url: 'https://github.com/acme/api/issues/1',
  ...over,
});

const group = (over: Partial<IssueGroup> = {}): IssueGroup => ({
  issueRef: 'acme/api#1',
  repo: 'acme/api',
  issueNumber: 1,
  title: 'Untouched issue',
  url: 'https://github.com/acme/api/issues/1',
  reproduce: null,
  fix: null,
  headline: 'reproducing',
  ...over,
});

describe('mergeIssuesWithGroups', () => {
  it('pairs an issue with its group by issueRef', () => {
    const rows = mergeIssuesWithGroups([issue()], [group()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).not.toBeNull();
    expect(rows[0]!.group!.issueRef).toBe('acme/api#1');
  });

  it('leaves group null for an issue Forge has not touched', () => {
    const rows = mergeIssuesWithGroups([issue({ number: 2 })], []);
    expect(rows[0]!.group).toBeNull();
  });

  it('preserves the input issue order', () => {
    const rows = mergeIssuesWithGroups(
      [issue({ number: 5 }), issue({ number: 3 }), issue({ number: 9 })],
      [],
    );
    expect(rows.map((r) => r.issue.number)).toEqual([5, 3, 9]);
  });

  it('ignores groups with no matching issue', () => {
    const rows = mergeIssuesWithGroups([issue({ number: 1 })], [
      group({ issueRef: 'acme/api#1' }),
      group({ issueRef: 'acme/api#999' }),
    ]);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- workspace-issues`
Expected: FAIL — cannot resolve `./workspace-issues`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/workspace-issues.ts`:

```ts
import type { TriageIssue } from './triage-planner';
import type { IssueGroup } from './triage-view';

export type WorkspaceIssueRow = {
  issue: TriageIssue;
  /** Null when Forge hasn't been asked to work on this issue yet. */
  group: IssueGroup | null;
};

/**
 * Pair each fetched GitHub issue with its triage progress (if any), keeping
 * the issues' own order (newest-first, as GitHub returned them). Groups with
 * no matching issue (e.g. a closed issue Forge worked on previously) are
 * dropped — the workspace only lists currently-open issues.
 */
export function mergeIssuesWithGroups(
  issues: TriageIssue[],
  groups: IssueGroup[],
): WorkspaceIssueRow[] {
  const byRef = new Map(groups.map((g) => [g.issueRef, g]));
  return issues.map((issue) => ({
    issue,
    group: byRef.get(`${issue.repo}#${issue.number}`) ?? null,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- workspace-issues`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/workspace-issues.ts apps/web/src/lib/workspace-issues.test.ts
git commit -m "feat(workspace): pure issue/progress merge for the workspace list"
```

---

### Task 7: `WorkOnItButton` client component

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/work-on-it-button.tsx`

**Interfaces:**
- Consumes: `workOnIssue` (Task 4), `type TriageHeadline` (`@/lib/triage-view`).
- Produces:
  ```tsx
  <WorkOnItButton
    repo={string}
    issue={{ number: number; title: string; body: string; url: string }}
    headline={TriageHeadline | null} // null = untouched
  />
  ```
  `headline` null → "Work on it" (enabled). Terminal headline (`fixed`/`not_reproduced`/`fix_skipped`/`failed`) → "Work again" (enabled). In-flight headline (`reproducing`/`fixing`/`fix_review`) → disabled, label shows the headline.

- [ ] **Step 1: Write the component**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/work-on-it-button.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { TriageHeadline } from '@/lib/triage-view';

import { workOnIssue } from './actions';

const TERMINAL: ReadonlySet<TriageHeadline> = new Set([
  'fixed',
  'not_reproduced',
  'fix_skipped',
  'failed',
]);

const IN_FLIGHT_LABEL: Record<string, string> = {
  reproducing: 'Reproducing…',
  fixing: 'Fixing…',
  fix_review: 'Awaiting review',
};

export function WorkOnItButton({
  repo,
  issue,
  headline,
}: {
  repo: string;
  issue: { number: number; title: string; body: string; url: string };
  headline: TriageHeadline | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const inFlight = headline !== null && !TERMINAL.has(headline);
  if (inFlight) {
    return (
      <Button disabled variant="secondary" size="sm">
        {IN_FLIGHT_LABEL[headline] ?? 'In progress'}
      </Button>
    );
  }

  const label = headline === null ? 'Work on it' : 'Work again';

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await workOnIssue(repo, issue);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <Button size="sm" onClick={handleClick} disabled={pending}>
        {pending ? 'Queuing…' : label}
      </Button>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/work-on-it-button.tsx"
git commit -m "feat(workspace): WorkOnItButton with duplicate-guard states"
```

---

### Task 8: `/repos/[owner]/[repo]` — the workspace page

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx` (client — search/filter + master-detail selection)

**Interfaces:**
- Consumes: `withAuth`, `resolveMissionDefaults` (`@/lib/mission-defaults-db`), `githubSearchIssues` (`@/lib/triage-planner`), `groupTasksByIssue` (`@/lib/triage-view`), `mergeIssuesWithGroups` (Task 6), `IssueTriageCard` (`@/components/issue-triage-card`), `WorkOnItButton` (Task 7), `listTasksForMission` (`@/lib/tasks`), `env.GITHUB_APP_TOKEN` (`@/lib/env`), `getOrCreateWorkspaceMission`'s read path only (the page itself must NOT create the mission — creation happens lazily inside `workOnIssue`; the page looks up an existing one and treats "none yet" as "no issues touched").

Because the page must not create a mission just by being viewed (a page load isn't "Work on it"), it needs a read-only lookup. Reuse the same query shape as `dbFindExisting` in `workspace-mission.ts`, but exported for read-only use:

- [ ] **Step 1: Export a read-only finder from `workspace-mission.ts`**

Modify `apps/web/src/lib/workspace-mission.ts`: export the existing `dbFindExisting` function (rename export to `findWorkspaceMission` for clarity at the call site, keep the internal `WorkspaceMissionDeps.findExisting` field name and behavior unchanged):

```ts
export async function findWorkspaceMission(userId: string, repo: string): Promise<Mission | null> {
  return dbFindExisting(userId, repo);
}
```

Place this new export right after the `dbFindExisting` function definition. Update `defaultDeps` to still reference `dbFindExisting` directly (no behavior change there).

Run: `pnpm --filter @forge/web typecheck` — clean.

```bash
git add apps/web/src/lib/workspace-mission.ts
git commit -m "feat(workspace): expose read-only findWorkspaceMission for page loads"
```

- [ ] **Step 2: Write the workspace page**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`:

```tsx
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';
import { resolveMissionDefaults } from '@/lib/mission-defaults-db';
import { listTasksForMission } from '@/lib/tasks';
import { githubSearchIssues } from '@/lib/triage-planner';
import { groupTasksByIssue } from '@/lib/triage-view';
import { withAuth } from '@/lib/with-auth';
import { findWorkspaceMission } from '@/lib/workspace-mission';
import { mergeIssuesWithGroups } from '@/lib/workspace-issues';

import { WorkspaceList } from './workspace-list';

export const dynamic = 'force-dynamic';

export default async function RepoWorkspacePage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo: repoName } = await params;
  const repo = `${owner}/${repoName}`;
  const user = await withAuth();

  if (!env.GITHUB_APP_TOKEN) {
    return (
      <main className="container max-w-3xl py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/repos">&larr; Repos</Link>
        </Button>
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Issue search needs a <code className="font-mono">GITHUB_APP_TOKEN</code> configured on
          the server. Ask an operator to set it, then reload this page.
        </div>
      </main>
    );
  }

  let search;
  try {
    search = await githubSearchIssues(`repo:${repo} is:issue is:open`);
  } catch (err) {
    return (
      <main className="container max-w-3xl py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/repos">&larr; Repos</Link>
        </Button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Couldn&apos;t load issues from GitHub:{' '}
          {err instanceof Error ? err.message : 'unknown error'}
        </div>
      </main>
    );
  }

  const [mission, defaults] = await Promise.all([
    findWorkspaceMission(user.id, repo),
    resolveMissionDefaults(user.id),
  ]);
  const tasks = mission ? await listTasksForMission(mission.id) : [];
  const groups = groupTasksByIssue(tasks);
  const rows = mergeIssuesWithGroups(search.issues, groups);

  return (
    <main className="container max-w-[1100px] py-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
        <Link href="/repos">&larr; Repos</Link>
      </Button>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} open issue{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        {mission ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/missions/${mission.id}`}>View mission</Link>
          </Button>
        ) : null}
      </div>
      <WorkspaceList repo={repo} rows={rows} missionId={mission?.id ?? null} />
    </main>
  );
}
```

- [ ] **Step 3: Write the client master-detail list**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`:

```tsx
'use client';

import { useMemo, useState } from 'react';

import { IssueTriageCard } from '@/components/issue-triage-card';
import { Input } from '@/components/ui/input';
import type { WorkspaceIssueRow } from '@/lib/workspace-issues';

import { WorkOnItButton } from './work-on-it-button';

export function WorkspaceList({
  repo,
  rows,
  missionId,
}: {
  repo: string;
  rows: WorkspaceIssueRow[];
  missionId: string | null;
}) {
  const [query, setQuery] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(rows[0]?.issue.number ?? null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.issue.title.toLowerCase().includes(q) || String(r.issue.number).includes(q),
    );
  }, [rows, query]);

  const selected = filtered.find((r) => r.issue.number === selectedNumber) ?? filtered[0] ?? null;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        No open issues in {repo}.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-4">
      <div className="rounded-lg border">
        <div className="border-b p-2">
          <Input
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {filtered.map((row) => (
            <button
              key={row.issue.number}
              type="button"
              onClick={() => setSelectedNumber(row.issue.number)}
              className={`block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent ${
                selected?.issue.number === row.issue.number ? 'bg-accent' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  #{row.issue.number}
                </span>
                {row.group ? (
                  <span className="text-xs text-muted-foreground">{row.group.headline}</span>
                ) : null}
              </div>
              <p className="truncate">{row.issue.title}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        {selected ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-lg font-medium">
                #{selected.issue.number} {selected.issue.title}
              </h2>
              <a
                href={selected.issue.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                View on GitHub
              </a>
            </div>
            {selected.group && missionId ? (
              <IssueTriageCard group={selected.group} missionId={missionId} />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {selected.issue.body || 'No description.'}
              </p>
            )}
            <WorkOnItButton
              repo={repo}
              issue={selected.issue}
              headline={selected.group?.headline ?? null}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No issue matches your search.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/acme/api`
Expected: `307` (auth redirect).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx"
git commit -m "feat(workspace): repo workspace master-detail page"
```

---

### Task 9: Sidebar entry + post-auth default route

**Files:**
- Modify: `apps/web/src/components/session-sidebar.tsx` (~line 59, the `<nav>` block)
- Modify: `apps/web/src/app/(app)/login/page.tsx` (lines ~38, ~53)
- Modify: `apps/web/src/app/(app)/signup/page.tsx` (lines ~40, ~55)

**Interfaces:** none — pure navigation wiring, no new exports.

- [ ] **Step 1: Add the sidebar entry**

In `apps/web/src/components/session-sidebar.tsx`, in the `<nav>` block, add a `Repos` link before `Dashboard` (since it's now the primary surface):

```tsx
        <NavLink href="/repos">Repos</NavLink>
        <NavLink href="/missions">Dashboard</NavLink>
        <NavLink href="/chat">Chat</NavLink>
        <NavLink href="/setup">Setup</NavLink>
```

- [ ] **Step 2: Point post-auth redirects at `/repos`**

In `apps/web/src/app/(app)/login/page.tsx`: change `router.push('/missions')` (email/password success) to `router.push('/repos')`, and change `callbackURL: '/missions'` (GitHub sign-in) to `callbackURL: '/repos'`.

In `apps/web/src/app/(app)/signup/page.tsx`: make the same two changes.

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos`
Expected: `307`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/session-sidebar.tsx "apps/web/src/app/(app)/login/page.tsx" "apps/web/src/app/(app)/signup/page.tsx"
git commit -m "feat(workspace): Repos in sidebar, land there after auth"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web and tick test suites**

Run: `pnpm --filter @forge/web test && pnpm --filter @forge/tick test`
Expected: all suites pass, including the new `workspace-mission.test.ts`, `workspace-issues.test.ts`, and `reconciler.test.ts` additions.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification (requires the signed-in operator, with `GITHUB_APP_TOKEN` set and at least one repo with open issues connected)**

Ask the operator to confirm:

1. Signing in lands on `/repos`; sidebar shows "Repos" above "Dashboard".
2. `/repos` lists connected repos; clicking one opens the workspace.
3. The workspace lists open issues, newest first; typing in the search box filters them; selecting a row shows its detail on the right.
4. Clicking "Work on it" on an untouched issue: button shows "Queuing…", then the page refreshes and the row shows a headline pill; the issue's detail pane now renders `IssueTriageCard`.
5. `/missions` shows a new mission named "Issues — {repo}", status `running`, budget uncapped.
6. Wait for a tick (`curl -X POST http://localhost:8180/tick` if not already ticking); confirm the reproduce task progresses and the workspace pill updates on next page load.
7. After the pair reaches a terminal state (or force one via test data), confirm the button reads "Work again" and clicking it enqueues a fresh pair without erroring.
8. Trigger the reconciler tick a few times while the standing mission has only terminal-state tasks; confirm in `/missions` that its status stays `running` (does not flip to `completed`).

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
