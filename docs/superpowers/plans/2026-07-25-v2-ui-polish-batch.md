# v2 UI Polish Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring six independent, low-to-medium-risk UI improvements from the v2 prototype into the real Forge app: a Setup page stepper, a Chat suggested-tasks landing state, a Repo workspace identity zone, an honest 2-step CI→Merge stepper, severity-tiered run output, and a Repos page rollup strip + table reshape.

**Architecture:** Each task modifies one existing page/component (plus, for three tasks, one small new query function) — no new dependencies, no schema changes, no shared new infrastructure between tasks. All six are independently mergeable and touch non-overlapping files (Task 6 touches two files no other task touches).

**Tech Stack:** Next.js App Router, React, Drizzle ORM (existing patterns only), Vitest.

## Global Constraints

- No new schema changes. No new npm dependencies.
- `awaiting_review` task status does NOT mean "GitHub PR approved" — Forge does not track GitHub's `review_decision`/`mergeable_state` anywhere (confirmed via full-codebase grep). Any UI referencing this status must not imply GitHub review approval; use the fixed copy "Needs human attention" only.
- CI/merge state lives entirely in `tasks.status` (the enum) — there are no separate CI-conclusion or review-decision columns on the `tasks` row. Derive all stepper/status display purely from `status` and `prUrl`.
- Task status enum (`packages/db/src/schema.ts:47-62`): `queued`, `dispatching`, `running`, `turn_ended`, `opening_pr`, `awaiting_ci`, `awaiting_verify`, `awaiting_ai_review`, `awaiting_review`, `merging`, `merged`, `resolved`, `abandoned`, `failed`.
- Date-boundary convention already used in this codebase (`apps/web/src/lib/home.ts:86`): `const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;` then compared via `sql\`${col} >= ${weekAgo}\``. Follow the same "plain millisecond timestamp via `Date`, compared in raw `sql`" style — do not introduce a date library.
- Real-DB-integration test convention (used throughout this session: `chat/route.test.ts`, `reconciler-pr.test.ts`, `setup/actions.test.ts`): a throwaway libSQL file (`/tmp/forge-<name>-${process.pid}.db`), real `drizzle-orm/libsql/migrator` migration, real inserts/queries — used for any task doing genuine DB aggregation. Pure-function logic gets plain unit tests, no DB.

---

### Task 1: Setup Page Stepper Header

**Files:**
- Modify: `apps/web/src/app/(app)/setup/page.tsx`
- Test: none (page component, no new business logic — matches this app's established "no rendering-component tests" convention)

**Interfaces:**
- Consumes: nothing new — the page already computes `installation` (truthy/falsy) and `connectedRepos.length` (zero/non-zero), which are the only two facts needed to derive the 3-step state.
- Produces: nothing consumed by other tasks.

Current relevant section of `apps/web/src/app/(app)/setup/page.tsx` (lines 50-53):

```tsx
  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />

      <div className="flex flex-col gap-4">
```

- [ ] **Step 1: Add the stepper header markup**

Replace the block above with:

```tsx
  const step = !installation ? 1 : connectedRepos.length === 0 ? 2 : 3;

  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />

      <div className="mb-6 flex items-center">
        {[
          { n: 1, label: 'Install' },
          { n: 2, label: 'Select repos' },
          { n: 3, label: 'Try it' },
        ].map((s, i, arr) => (
          <div key={s.n} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
                  (step > s.n
                    ? 'bg-live/15 text-live'
                    : step === s.n
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground')
                }
              >
                {step > s.n ? '✓' : s.n}
              </span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            {i < arr.length - 1 ? <div className="mx-3 h-px flex-1 bg-border" /> : null}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-4">
```

Note: `installation` and `connectedRepos` are already in scope at this point in the function (declared above at lines 17-30) — `step` just needs to be computed once, right before the `return`.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 3: Manual verification**

Start the dev server and load `/setup` in each of the three real states (no installation; installation with zero repos; installation with ≥1 repo) — confirm the stepper's checkmark/current/upcoming states match. If the sandbox has no way to reach a real GitHub App installation, say so explicitly in the report rather than claiming this was verified.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/setup/page.tsx
git commit -m "feat(web): add a 3-step progress header to the setup page"
```

---

### Task 2: Chat Suggested-Tasks Landing State

**Files:**
- Modify: `apps/web/src/app/(app)/chat/page.tsx`
- Modify: `apps/web/src/app/(app)/chat/chat-interface.tsx`
- Test: `apps/web/src/lib/recent-missions.test.ts` (new file, for the new query function)
- Create: `apps/web/src/lib/recent-missions.ts`

**Interfaces:**
- Produces: `listRecentMissions(userId: string, limit: number): Promise<Array<{ id: string; name: string; status: MissionStatus }>>` — a new exported function, used by `chat/page.tsx`.
- Produces: `ChatInterface` gains a new optional prop `recentMissions?: Array<{ id: string; name: string; status: MissionStatus }>` — no other task touches this component's props.

Current `apps/web/src/app/(app)/chat/page.tsx` (full file):

```tsx
import { ConsoleShell } from '@/components/console-shell';
import { withAuth } from '@/lib/with-auth';

import { ChatInterface } from './chat-interface';

export default async function ChatPage() {
  await withAuth();
  // Chat is a full-height conversation UI, not a document page: it manages its
  // own scroll region and prompt bar padding, so ConsoleShell wraps it with
  // the outer padding zeroed out rather than forcing PageShell's centered
  // document layout.
  return (
    <ConsoleShell className="p-0">
      <ChatInterface />
    </ConsoleShell>
  );
}
```

- [ ] **Step 1: Write the failing test for `listRecentMissions`**

Create `apps/web/src/lib/recent-missions.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { missions } from '@forge/db';

import { listRecentMissions } from './recent-missions';

const DB_PATH = `/tmp/forge-recent-missions-${process.pid}.db`;

vi.mock('./db', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const client = createClient({ url: `file:${DB_PATH}` });
  return { db: drizzle(client) };
});

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const client = createClient({ url: `file:${DB_PATH}` });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: '../../packages/db/migrations' });
});

afterAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

function insertMission(overrides: Partial<typeof missions.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId: 'user_1',
    name: 'test mission',
    goal: 'test goal',
    status: 'running' as const,
    backend: 'managed-agents' as const,
    agentId: 'agent_1',
    plannerStrategy: 'rule-based' as const,
    targetRepos: ['owner/repo'],
    concurrencyCap: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('listRecentMissions', () => {
  it('returns the most recent missions for a user, newest first, limited', async () => {
    const older = insertMission({ id: 'msn_older00000000001', name: 'older', createdAt: new Date(Date.now() - 10000) });
    const newer = insertMission({ id: 'msn_newer00000000002', name: 'newer', createdAt: new Date() });
    const other = insertMission({ id: 'msn_other00000000003', name: 'other user', userId: 'user_2' });
    await db.insert(missions).values([older, newer, other]);

    const result = await listRecentMissions('user_1', 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'msn_newer00000000002', name: 'newer' });
    expect(result[1]).toMatchObject({ id: 'msn_older00000000001', name: 'older' });
  });

  it('returns an empty array for a user with no missions', async () => {
    const result = await listRecentMissions('user_no_missions', 2);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/recent-missions.test.ts`
Expected: FAIL — `Cannot find module './recent-missions'`

- [ ] **Step 3: Write `apps/web/src/lib/recent-missions.ts`**

```ts
import { desc, eq, sql } from '@forge/db/orm';
import { missions, type MissionStatus } from '@forge/db';

import { db } from './db';

export type RecentMission = { id: string; name: string; status: MissionStatus };

/** The user's most recent missions, newest first — used for the chat
 *  page's landing-state "Recent" list. */
export async function listRecentMissions(userId: string, limit: number): Promise<RecentMission[]> {
  const rows = await db
    .select({ id: missions.id, name: missions.name, status: missions.status })
    .from(missions)
    .where(sql`${missions.userId} = ${userId}`)
    .orderBy(desc(missions.createdAt))
    .limit(limit);

  return rows;
}
```

Check the exact import path for `MissionStatus` and the `sql`/`eq`/`desc` re-exports by grepping how `apps/web/src/app/(app)/api/chat/route.ts`'s `list_missions` tool (~line 160-194) imports the same helpers — match that file's import style exactly (it uses `@forge/db/orm` for `desc`/`eq`/`sql` and `@forge/db` for the table/type, per this plan's Global Constraints note on established patterns). If `eq` ends up unused after matching the route's exact query shape, remove it from the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/recent-missions.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire the query into `chat/page.tsx`**

Replace the full file with:

```tsx
import { ConsoleShell } from '@/components/console-shell';
import { listRecentMissions } from '@/lib/recent-missions';
import { withAuth } from '@/lib/with-auth';

import { ChatInterface } from './chat-interface';

export default async function ChatPage() {
  const user = await withAuth();
  const recentMissions = await listRecentMissions(user.id, 2);
  // Chat is a full-height conversation UI, not a document page: it manages its
  // own scroll region and prompt bar padding, so ConsoleShell wraps it with
  // the outer padding zeroed out rather than forcing PageShell's centered
  // document layout.
  return (
    <ConsoleShell className="p-0">
      <ChatInterface recentMissions={recentMissions} />
    </ConsoleShell>
  );
}
```

- [ ] **Step 6: Replace the empty-state block in `chat-interface.tsx`**

Current block (lines 58-73 of `apps/web/src/app/(app)/chat/chat-interface.tsx`):

```tsx
  return (
    <div className="flex h-full flex-col">
      {/* Chat area */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {!hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center">
            <h1 className="mb-2 font-title text-4xl uppercase tracking-tight text-muted-foreground/20">
              FORGE
            </h1>
            <p className="mb-1 text-sm text-muted-foreground">
              What would you like to work on?
            </p>
            <p className="text-xs text-muted-foreground/60">
              Describe a task. Forge dispatches an agent to do it.
            </p>
          </div>
        ) : (
```

Replace with:

```tsx
  return (
    <div className="flex h-full flex-col">
      {/* Chat area */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {!hasMessages ? (
          <div className="mx-auto flex h-full max-w-[560px] flex-col justify-center px-6">
            <p className="mb-5 text-center text-sm text-muted-foreground">
              What would you like to work on?
            </p>
            <div className="mb-6 grid grid-cols-2 gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => setInput(s.prompt)}
                  className="rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                >
                  <p className="text-xs font-semibold">{s.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{s.description}</p>
                </button>
              ))}
            </div>
            {recentMissions.length > 0 ? (
              <div>
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Recent
                </p>
                <div className="flex flex-col gap-1">
                  {recentMissions.map((m) => (
                    <Link
                      key={m.id}
                      href={`/missions/${m.id}`}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
                    >
                      <span className="truncate">{m.name}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{m.status}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
```

- [ ] **Step 7: Add the imports, props, and `SUGGESTIONS` constant**

At the top of `chat-interface.tsx`, add `Link` to the `next/link` import (currently `chat-interface.tsx` doesn't import `next/link` at all — check the current import list and add it), and add a `RecentMission` type import:

```tsx
import Link from 'next/link';

import type { RecentMission } from '@/lib/recent-missions';
```

Add the suggestions constant near `MCP_TOOLS`:

```tsx
const SUGGESTIONS = [
  { title: 'Fix a failing test', description: 'Point Forge at a red CI run to root-cause and patch it.', prompt: 'Find the currently failing test in ' },
  { title: 'Triage open issues', description: 'Rank and reproduce every open bug in a repo.', prompt: 'Triage all open issues in ' },
  { title: 'Bump a dependency, fleet-wide', description: "Apply the same change and open PRs across every connected repo.", prompt: 'Bump ' },
  { title: 'Add a feature', description: 'Describe the outcome; Forge plans the steps before touching code.', prompt: '' },
];
```

Change the component signature from `export function ChatInterface() {` to:

```tsx
export function ChatInterface({ recentMissions = [] }: { recentMissions?: RecentMission[] }) {
```

- [ ] **Step 8: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 9: Run the full test suite**

Run: `cd apps/web && pnpm vitest run`
Expected: all existing tests still pass, plus the 2 new `recent-missions.test.ts` tests.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/recent-missions.ts apps/web/src/lib/recent-missions.test.ts apps/web/src/app/\(app\)/chat/page.tsx apps/web/src/app/\(app\)/chat/chat-interface.tsx
git commit -m "feat(web): replace the blank chat landing state with suggestions + recent missions"
```

---

### Task 3: Repo Workspace Identity Zone

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`
- Modify: `apps/web/src/lib/repo-activity.ts`
- Test: `apps/web/src/lib/repo-activity.test.ts` (new file — no test file exists for this lib today; check this is actually true before creating, in case one was added since last read)

**Interfaces:**
- Produces: `countMissionsThisMonth(userId: string, repo: string): Promise<number>` in `repo-activity.ts` — no other task uses this.

Current relevant section of `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx` (lines 104-136 — read the file first to confirm line numbers haven't shifted, since other work may have touched this file):

```tsx
  return (
    <ConsoleShell>
      <HeaderPortal>
        <RepoTabs active={activeTab} repo={repo} />
      </HeaderPortal>
      <div className="shrink-0">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 title={repo} className="truncate font-mono text-2xl font-semibold tracking-tight">
                {repo}
              </h1>
              {hasActiveWork ? <LiveRefresh intervalMs={5000} /> : null}
            </div>
            <div className="mt-1 flex items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {rows.length} open issue{rows.length === 1 ? '' : 's'}
              </p>
              <RepoBudgetLine budget={repoBudget} />
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <NewIssueDialog owner={owner} repo={repoName} />
            <RepoToolbar
              repo={repo}
              containerStatus={
                mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
              }
              missionsHref={mission ? `/missions?repo=${encodeURIComponent(repo)}` : null}
            />
          </div>
        </div>
      </div>
```

Note: the "Files" button lives inside `workspace-list.tsx` (opens a per-issue Sheet tied to `activeConsole` state) — it is **not** moved into this identity zone. It's scoped to the currently-active task's file browser and isn't accessible from this server component. Do not move it; the spec's mention of relocating it was based on an incorrect assumption about where it lives, corrected here.

- [ ] **Step 1: Write the failing test for `countMissionsThisMonth`**

Create `apps/web/src/lib/repo-activity.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { missions } from '@forge/db';

const DB_PATH = `/tmp/forge-repo-activity-${process.pid}.db`;

vi.mock('./db', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const client = createClient({ url: `file:${DB_PATH}` });
  return { db: drizzle(client) };
});

import { countMissionsThisMonth } from './repo-activity';

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const client = createClient({ url: `file:${DB_PATH}` });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: '../../packages/db/migrations' });
});

afterAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

function insertMission(overrides: Partial<typeof missions.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId: 'user_1',
    name: 'test mission',
    goal: 'test goal',
    status: 'running' as const,
    backend: 'managed-agents' as const,
    agentId: 'agent_1',
    plannerStrategy: 'rule-based' as const,
    targetRepos: ['owner/repo'],
    concurrencyCap: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('countMissionsThisMonth', () => {
  it('counts missions targeting this repo created this calendar month', async () => {
    const thisMonth = insertMission({ id: 'msn_thismonth000000001' });
    const lastMonth = insertMission({
      id: 'msn_lastmonth000000002',
      createdAt: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15),
    });
    const otherRepo = insertMission({ id: 'msn_otherrepo000000003', targetRepos: ['owner/other'] });
    await db.insert(missions).values([thisMonth, lastMonth, otherRepo]);

    const count = await countMissionsThisMonth('user_1', 'owner/repo');
    expect(count).toBe(1);
  });

  it('returns 0 for a repo with no missions this month', async () => {
    const count = await countMissionsThisMonth('user_1', 'owner/nonexistent');
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/repo-activity.test.ts`
Expected: FAIL — `countMissionsThisMonth is not a function` (or similar — the export doesn't exist yet)

- [ ] **Step 3: Add `countMissionsThisMonth` to `repo-activity.ts`**

Append to `apps/web/src/lib/repo-activity.ts` (after the existing `listTasksTouchingRepo` function):

```ts

/** Missions targeting this repo created since the start of the current
 *  calendar month — the repo workspace identity zone's "missions this
 *  month" stat. Follows the same plain-Date-timestamp comparison style
 *  as getDashboardStats's `weekAgo` in home.ts, not a date library. */
export async function countMissionsThisMonth(userId: string, repo: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const rows = await db
    .select({ id: missions.id, targetRepos: missions.targetRepos })
    .from(missions)
    .where(and(eq(missions.userId, userId), sql`${missions.createdAt} >= ${monthStart}`));

  return rows.filter((m) => (m.targetRepos ?? []).includes(repo)).length;
}
```

Add `missions` to the existing `@forge/db` import and `sql` to the existing `drizzle-orm` import at the top of the file (current imports are `import { and, desc, eq } from 'drizzle-orm';` and `import { missions, tasks, type Task } from '@forge/db';` — `missions` is already imported; only `sql` needs adding to the `drizzle-orm` import).

Filtering `targetRepos` in application code (not SQL) is deliberate: the column is a JSON-mode text column (`text('target_repos', { mode: 'json' })`), and this codebase doesn't currently do JSON-array `LIKE`/contains filtering in SQL anywhere — matching `groupMissionsByRepo`'s existing app-level iteration over `mission.targetRepos` in `group-missions-by-repo.ts` rather than inventing a new SQL pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/repo-activity.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Replace the header in `repos/[owner]/[repo]/page.tsx` with the identity zone**

First, add the new query call near the other `Promise.all`/await calls in the page function (find where `repoBudget`/`mission`/`rows` are computed and add alongside):

```tsx
  const missionsThisMonth = await countMissionsThisMonth(user.id, repo);
```

Add the import: `import { countMissionsThisMonth, listTasksTouchingRepo } from '@/lib/repo-activity';` (merge with the existing `listTasksTouchingRepo` import rather than duplicating the import line — check the current import statement for `repo-activity` first).

Then replace the header block shown above with:

```tsx
      <div className="shrink-0">
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 title={repo} className="truncate font-mono text-lg font-semibold tracking-tight">
              {repo}
            </h1>
            <span className="flex shrink-0 items-center gap-1 text-xs text-live">
              <span className="inline-block size-1.5 rounded-full bg-live" />
              Connected
            </span>
            {hasActiveWork ? <LiveRefresh intervalMs={5000} /> : null}
          </div>
          <div className="flex shrink-0 items-center gap-6">
            <div className="text-right">
              <p className="font-mono text-sm font-semibold">{rows.length}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open issues</p>
            </div>
            <div className="text-right">
              <RepoBudgetLine budget={repoBudget} />
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Spend</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm font-semibold">{missionsThisMonth}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Missions this month</p>
            </div>
          </div>
        </div>
        <div className="mb-4 flex items-start justify-end gap-2">
          <NewIssueDialog owner={owner} repo={repoName} />
          <RepoToolbar
            repo={repo}
            containerStatus={mission ? (mission.status === 'paused' ? 'paused' : 'running') : null}
            missionsHref={mission ? `/missions?repo=${encodeURIComponent(repo)}` : null}
          />
        </div>
      </div>
```

Before writing this edit, re-read the current file to confirm the exact surrounding code (variable names `rows`, `repoBudget`, `mission`, `hasActiveWork`, `owner`, `repoName` are all already in scope per the file's existing structure read during planning — verify none have been renamed since).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 7: Run the full test suite**

Run: `cd apps/web && pnpm vitest run`
Expected: all existing tests pass, plus the 2 new `repo-activity.test.ts` tests.

- [ ] **Step 8: Manual verification**

Load a repo workspace page in the dev server and confirm the identity zone renders with real numbers. If the sandbox can't reach a real GitHub-connected repo with mission history, say so explicitly rather than claiming this was verified.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/repo-activity.ts apps/web/src/lib/repo-activity.test.ts apps/web/src/app/\(app\)/repos/\[owner\]/\[repo\]/page.tsx
git commit -m "feat(web): give the repo workspace a persistent identity zone"
```

---

### Task 4: Merge-State Stepper (CI → Merge)

**Files:**
- Create: `apps/web/src/lib/merge-stepper.ts`
- Test: `apps/web/src/lib/merge-stepper.test.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`

**Interfaces:**
- Produces: `deriveMergeStepper(status: TaskStatus, prUrl: string | null): MergeStepperState` where:
  ```ts
  export type StepState = 'done' | 'active' | 'upcoming';
  export type MergeStepperState =
    | { kind: 'hidden' }
    | { kind: 'failed' }
    | { kind: 'steps'; ci: StepState; merge: StepState; needsAttention: boolean };
  ```
- No other task consumes this.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/merge-stepper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { deriveMergeStepper } from './merge-stepper';

describe('deriveMergeStepper', () => {
  it('is hidden when there is no PR yet', () => {
    expect(deriveMergeStepper('running', null)).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('opening_pr', null)).toEqual({ kind: 'hidden' });
  });

  it('shows CI active, merge upcoming while awaiting_ci', () => {
    expect(deriveMergeStepper('awaiting_ci', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'active',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, merge upcoming, and needsAttention for awaiting_review', () => {
    expect(deriveMergeStepper('awaiting_review', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: true,
    });
  });

  it('shows CI done, merge upcoming (no attention) for internal gate statuses', () => {
    expect(deriveMergeStepper('awaiting_verify', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: false,
    });
    expect(deriveMergeStepper('awaiting_ai_review', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'upcoming',
      needsAttention: false,
    });
  });

  it('shows CI done, merge active while merging', () => {
    expect(deriveMergeStepper('merging', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'active',
      needsAttention: false,
    });
  });

  it('shows both done once merged', () => {
    expect(deriveMergeStepper('merged', 'https://github.com/o/r/pull/1')).toEqual({
      kind: 'steps',
      ci: 'done',
      merge: 'done',
      needsAttention: false,
    });
  });

  it('is a distinct failed state for failed status, not attributed to a specific step', () => {
    expect(deriveMergeStepper('failed', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'failed' });
  });

  it('is hidden for statuses that should never have a PR yet', () => {
    expect(deriveMergeStepper('queued', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('resolved', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
    expect(deriveMergeStepper('abandoned', 'https://github.com/o/r/pull/1')).toEqual({ kind: 'hidden' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/merge-stepper.test.ts`
Expected: FAIL — `Cannot find module './merge-stepper'`

- [ ] **Step 3: Write `apps/web/src/lib/merge-stepper.ts`**

```ts
import type { TaskStatus } from '@forge/db';

export type StepState = 'done' | 'active' | 'upcoming';

export type MergeStepperState =
  | { kind: 'hidden' }
  | { kind: 'failed' }
  | { kind: 'steps'; ci: StepState; merge: StepState; needsAttention: boolean };

const PAST_CI = new Set<TaskStatus>([
  'awaiting_verify',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
]);

/**
 * Derives an honest 2-step CI -> Merge display from the task's real status.
 * Deliberately excludes a "Review" step: Forge does not fetch GitHub's
 * review_decision/mergeable_state anywhere, so there is no real signal to
 * show one. `awaiting_review` (Forge's internal "escalated to a human for
 * any reason" state) surfaces via `needsAttention` instead of a fake step.
 */
export function deriveMergeStepper(status: TaskStatus, prUrl: string | null): MergeStepperState {
  if (!prUrl) return { kind: 'hidden' };
  if (status === 'failed') return { kind: 'failed' };

  if (status === 'awaiting_ci') {
    return { kind: 'steps', ci: 'active', merge: 'upcoming', needsAttention: false };
  }
  if (PAST_CI.has(status)) {
    return {
      kind: 'steps',
      ci: 'done',
      merge: status === 'merged' ? 'done' : status === 'merging' ? 'active' : 'upcoming',
      needsAttention: status === 'awaiting_review',
    };
  }

  // queued/dispatching/running/turn_ended/opening_pr/resolved/abandoned:
  // a PR shouldn't realistically exist yet (or the task is done/abandoned
  // via a path that doesn't need this display) — hide rather than guess.
  return { kind: 'hidden' };
}
```

Check the exact name and import path of the task status type (`TaskStatus`) by grepping `packages/db/src/schema.ts` or `packages/db`'s exported types — the plan assumes `TaskStatus` is exported from `@forge/db` alongside `Task`; if the actual exported type name differs, use the real one.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/merge-stepper.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Render the stepper in `issue-run-panel.tsx`**

Add the import near the top of `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`:

```tsx
import { deriveMergeStepper } from '@/lib/merge-stepper';
```

Add the derived value alongside the other `task`-derived values (near `const assistantMessage = lastAssistantMessage(ledger);`):

```tsx
  const mergeStepper = task ? deriveMergeStepper(task.status, task.prUrl) : { kind: 'hidden' as const };
```

Insert the stepper markup right after the `prChips` block and before the `assistantMessage` block (i.e., between the existing `{prChips.length > 0 ? (...) : null}` block and the `{assistantMessage ? (...) : null}` block):

```tsx
        {mergeStepper.kind === 'steps' ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            {mergeStepper.needsAttention ? (
              <span className="mr-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                Needs human attention
              </span>
            ) : null}
            <StepDot state={mergeStepper.ci} label="CI" />
            <span className="h-px w-4 bg-border" />
            <StepDot state={mergeStepper.merge} label="Merge" />
          </div>
        ) : mergeStepper.kind === 'failed' ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Task failed — see run output for details.
          </p>
        ) : null}
```

Add a small local `StepDot` helper component in the same file, above `IssueRunPanel`:

```tsx
function StepDot({ state, label }: { state: import('@/lib/merge-stepper').StepState; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={
          'flex size-4 items-center justify-center rounded-full text-[9px] font-bold ' +
          (state === 'done'
            ? 'bg-live/15 text-live'
            : state === 'active'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground')
        }
      >
        {state === 'done' ? '✓' : ''}
      </span>
      {label}
    </span>
  );
}
```

(The inline `import('@/lib/merge-stepper').StepState` type usage avoids a second named import line — if the implementer prefers, add `StepState` to the existing `deriveMergeStepper` import instead: `import { deriveMergeStepper, type StepState } from '@/lib/merge-stepper';` and use `StepState` directly in the `StepDot` signature. Either is fine; pick one and be consistent.)

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 7: Run the full test suite**

Run: `cd apps/web && pnpm vitest run`
Expected: all existing tests pass, plus the 8 new `merge-stepper.test.ts` tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/merge-stepper.ts apps/web/src/lib/merge-stepper.test.ts apps/web/src/app/\(app\)/repos/\[owner\]/\[repo\]/issue-run-panel.tsx
git commit -m "feat(web): replace the flat PR status badge with an honest CI→Merge stepper"
```

---

### Task 5: Severity-Tiered Run Output

**Files:**
- Create: `apps/web/src/lib/partition-ledger.ts`
- Test: `apps/web/src/lib/partition-ledger.test.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`

**Interfaces:**
- Produces: `partitionLedgerByAttention(ledger: LogEventLike[]): { attention: LogEventLike[]; activity: LogEventLike[] }` — consumed only by `workspace-list.tsx`.
- Consumes: `isErrorLogEvent` and `formatLogLine` from `@/lib/session-log-format` (both already exist and are already tested).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/partition-ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { partitionLedgerByAttention } from './partition-ledger';

describe('partitionLedgerByAttention', () => {
  it('splits error events into attention, everything else into activity', () => {
    const ledger = [
      { eventType: 'agent.message', payload: {} },
      { eventType: 'agent.tool_result', payload: { is_error: true } },
      { eventType: 'agent.tool_use', payload: {} },
      { eventType: 'session.error', payload: { error: { message: 'boom' } } },
    ];

    const { attention, activity } = partitionLedgerByAttention(ledger);

    expect(attention).toHaveLength(2);
    expect(attention.map((e) => e.eventType)).toEqual(['agent.tool_result', 'session.error']);
    expect(activity).toHaveLength(2);
    expect(activity.map((e) => e.eventType)).toEqual(['agent.message', 'agent.tool_use']);
  });

  it('returns an empty attention list when there are no error events', () => {
    const ledger = [{ eventType: 'agent.message', payload: {} }];
    const { attention, activity } = partitionLedgerByAttention(ledger);
    expect(attention).toEqual([]);
    expect(activity).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/partition-ledger.test.ts`
Expected: FAIL — `Cannot find module './partition-ledger'`

- [ ] **Step 3: Write `apps/web/src/lib/partition-ledger.ts`**

```ts
import { isErrorLogEvent, type LogEventLike } from './session-log-format';

/** Splits a chronological ledger into events that need a human's attention
 *  (real errors, per `isErrorLogEvent`) and everything else. Used by the
 *  repo workspace's Run output column to lead with what's actually
 *  actionable instead of a flat scrolling stream. */
export function partitionLedgerByAttention<T extends LogEventLike>(
  ledger: T[],
): { attention: T[]; activity: T[] } {
  const attention: T[] = [];
  const activity: T[] = [];
  for (const event of ledger) {
    (isErrorLogEvent(event) ? attention : activity).push(event);
  }
  return { attention, activity };
}
```

Check that `LogEventLike` is actually exported from `session-log-format.ts` (it's referenced as a type in `issue-run-panel.tsx`'s `LedgerRow` already, but confirm the exact export before importing it — if it isn't exported, export it as part of this step rather than redefining an equivalent type locally).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/partition-ledger.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Update the Run output column in `workspace-list.tsx`**

Read the file first to get the current exact Run output column block (it has been modified several times this session — do not assume the version below is byte-exact; use it as the shape to match, adjusting to whatever the real current block looks like). The block to change is the third grid column, currently structured as:

```tsx
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div className="shrink-0 border-b bg-muted/40 px-3 py-1.5">
          <SectionLabel>Run output</SectionLabel>
        </div>
        {activeConsole ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SessionLogView
              key={activeConsole.task.id}
              taskId={activeConsole.task.id}
              isLive={activeConsole.isLive}
              initialEvents={activeConsole.ledger}
              maxLines={300}
              className="h-full rounded-none border-0"
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            No task selected.
          </div>
        )}
      </div>
```

Replace with:

```tsx
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div className="shrink-0 border-b bg-muted/40 px-3 py-1.5">
          <SectionLabel>Run output</SectionLabel>
        </div>
        {activeConsole ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {(() => {
              const { attention, activity } = partitionLedgerByAttention(activeConsole.ledger);
              return attention.length > 0 ? (
                <div className="shrink-0 border-b">
                  {attention.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 border-b px-3 py-2 text-xs last:border-b-0">
                      <span className="mt-0.5 shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-destructive">
                        Blocker
                      </span>
                      <span className="text-muted-foreground">{formatLogLine(e)}</span>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}
            <details className="min-h-0 flex-1" open={activeConsole.ledger.length <= 0}>
              <summary className="cursor-pointer border-b bg-muted/20 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Activity ({activeConsole.ledger.length} events)
              </summary>
              <SessionLogView
                key={activeConsole.task.id}
                taskId={activeConsole.task.id}
                isLive={activeConsole.isLive}
                initialEvents={activeConsole.ledger}
                maxLines={300}
                className="h-full rounded-none border-0"
              />
            </details>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            No task selected.
          </div>
        )}
      </div>
```

Add the imports at the top of `workspace-list.tsx`:

```tsx
import { formatLogLine } from '@/lib/session-log-format';
import { partitionLedgerByAttention } from '@/lib/partition-ledger';
```

(`formatLogLine` may already be imported in this file for other reasons — check first and merge rather than duplicate. `SessionLogView`, `SectionLabel` are already imported per the existing file.)

Note on the `<details>` `open` default: it's collapsed by default per the spec whenever there's at least one event (`open={activeConsole.ledger.length <= 0}` evaluates to `false`/collapsed for any non-empty ledger, and `true`/expanded only for a literally-empty ledger, which is a reasonable "nothing to hide" edge case — not load-bearing, simplest correct behavior).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 7: Run the full test suite**

Run: `cd apps/web && pnpm vitest run`
Expected: all existing tests pass, plus the 2 new `partition-ledger.test.ts` tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/partition-ledger.ts apps/web/src/lib/partition-ledger.test.ts apps/web/src/app/\(app\)/repos/\[owner\]/\[repo\]/workspace-list.tsx
git commit -m "feat(web): lead Run output with a Needs Attention tier, collapse the rest"
```

---

### Task 6: Repos Page Rollup Strip + Table Reshape

**Files:**
- Modify: `apps/web/src/lib/repo-activity.ts`
- Test: `apps/web/src/lib/repo-activity.test.ts` (extends the file Task 3 creates — if Task 3 hasn't run yet in this execution order, create it fresh with both Task 3's and this task's tests; if Task 3 already created it, add to it)
- Modify: `apps/web/src/app/(app)/repos/page.tsx`
- Modify: `apps/web/src/components/repos-table.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (this task's `countBlockedTasksByRepo` is independent of Task 3's `countMissionsThisMonth`, even though both live in `repo-activity.ts`).
- Produces: `countBlockedTasksByRepo(userId: string): Promise<Map<string, number>>` in `repo-activity.ts`.
- Produces: `ReposTable`'s `RepoRow` type gains a `blockers: number` field — no other task uses `RepoRow`.

- [ ] **Step 1: Write the failing test for `countBlockedTasksByRepo`**

Add to `apps/web/src/lib/repo-activity.test.ts` (creating the file per Task 3's Step 1 shape if it doesn't exist yet — same `DB_PATH`/`vi.mock('./db', ...)`/`beforeAll`/`afterAll` scaffold, do not duplicate a second scaffold in the same file):

```ts
import { tasks } from '@forge/db';
// (add this import alongside the existing `missions` import from '@forge/db')

function insertTask(missionId: string, overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const now = new Date();
  return {
    id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId,
    repo: 'owner/repo',
    baseBranch: 'main',
    status: 'running' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('countBlockedTasksByRepo', () => {
  it('counts tasks in awaiting_review status, grouped by repo, for a user', async () => {
    const mission = insertMission({ id: 'msn_blockertest0000001', targetRepos: ['owner/repo'] });
    await db.insert(missions).values(mission);
    await db.insert(tasks).values([
      insertTask(mission.id, { id: 'tsk_blocked0000000001', status: 'awaiting_review', repo: 'owner/repo' }),
      insertTask(mission.id, { id: 'tsk_blocked0000000002', status: 'awaiting_review', repo: 'owner/repo' }),
      insertTask(mission.id, { id: 'tsk_running00000000003', status: 'running', repo: 'owner/repo' }),
    ]);

    const result = await countBlockedTasksByRepo('user_1');
    expect(result.get('owner/repo')).toBe(2);
  });

  it('omits repos with zero blocked tasks from the map', async () => {
    const result = await countBlockedTasksByRepo('user_with_no_blockers');
    expect(result.has('owner/repo')).toBe(false);
  });
});
```

Add `countBlockedTasksByRepo` to the import from `./repo-activity` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/repo-activity.test.ts`
Expected: FAIL — `countBlockedTasksByRepo is not a function`

- [ ] **Step 3: Add `countBlockedTasksByRepo` to `repo-activity.ts`**

Append:

```ts

/** Maps repo -> count of that repo's tasks currently in `awaiting_review`
 *  ("escalated to a human for any reason" — see merge-stepper.ts for why
 *  this is the one real proxy Forge has for "this needs attention today").
 *  Repos with zero such tasks are omitted from the returned map. */
export async function countBlockedTasksByRepo(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ repo: tasks.repo, count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), eq(tasks.status, 'awaiting_review')))
    .groupBy(tasks.repo);

  return new Map(rows.map((r) => [r.repo, Number(r.count)]));
}
```

`tasks`, `and`, `eq`, `sql` are already imported per Task 3's edit to this file's import lines (`tasks` was already imported for `listTasksTouchingRepo`; `sql` was added in Task 3). If executing this task before Task 3 (parallel-safe per this plan, but check), add whichever of `and`/`eq`/`sql`/`missions` is still missing from the top-of-file imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/repo-activity.test.ts`
Expected: PASS (4 tests total: Task 3's 2 + this task's 2, if both tasks' tests live in the same file; PASS (2 tests) if this task runs before Task 3 and the file only has these two so far)

- [ ] **Step 5: Add the rollup strip and blocker/mission counts to `repos/page.tsx`**

Read the current file first to confirm nothing has shifted since last read this session. In the section computing `rows` (after the `sparklines` computation, before the `return`), add:

```tsx
  const blockersByRepo = await countBlockedTasksByRepo(user.id);
  const connectedRepos = await listUserRepos(user.id);
```

(`listUserRepos` is already imported in this file for the empty-state branch — reuse it here for the rollup strip's "repos connected" count, which must reflect ALL connected repos, not just `repoNames` — `repoNames` only contains repos with at least one mission matching the current filters, a materially different and smaller set.)

Extend the `rows` mapping to include a mission count and blocker count:

```tsx
  const rows = repoNames.map((repo) => {
    const repoMissions = missionsByRepo.get(repo)!;
    const summary = summarizeRepoMissions(repoMissions);
    const sparkline = repoMissions.reduce<number[]>((acc, m) => {
      const s = sparklines.get(m.id) ?? [];
      return acc.map((v, i) => v + (s[i] ?? 0));
    }, new Array(30).fill(0));
    const missionCount = summary.breakdown.reduce((sum, b) => sum + b.count, 0);
    const blockers = blockersByRepo.get(repo) ?? 0;
    return { repo, summary, sparkline, missionCount, blockers };
  });
```

Add the rollup strip markup, right after `<PageHeader ... />` and before the `<MissionFilters>` div:

```tsx
      <div className="rise rise-1 mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">{connectedRepos.length}</p>
          <p className="text-xs text-muted-foreground">Repos connected</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">{[...blockersByRepo.keys()].length}</p>
          <p className="text-xs text-muted-foreground">Repos with open blockers</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">${stats.spentUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Total spend</p>
        </div>
      </div>
```

Renumber the existing `rise-1`/`rise-2` classNames on the `MissionFilters`/`ReposTable` wrapper divs below to `rise-2`/`rise-3` respectively, since the rollup strip now takes `rise-1`'s position (check the current `rise-N` values on those two divs before renaming — this plan assumes they're currently `rise-1` and `rise-2` per the last read of this file this session).

Add imports for `countBlockedTasksByRepo` (alongside wherever `listTasksTouchingRepo`/other `repo-activity` imports already exist in this file, or as a new import line if none exist yet in this specific file).

- [ ] **Step 6: Add the Missions/Blockers columns to `repos-table.tsx`**

Extend the `RepoRow` type:

```tsx
export type RepoRow = {
  repo: string;
  summary: {
    status: 'running' | 'completed';
    breakdown: Array<{ status: MissionStatus; count: number }>;
    mostRecentCreatedAt: Date;
  };
  sparkline: number[];
  missionCount: number;
  blockers: number;
};
```

Add two `<TableHead>` entries after "Progress" and before "Activity (24h)":

```tsx
          <TableHead>Missions</TableHead>
          <TableHead>Blockers</TableHead>
```

Add the corresponding `<TableCell>`s in the row-mapping, in the same position (after the Progress cell, before the Activity sparkline cell):

```tsx
              <TableCell className="font-mono text-sm">{missionCount}</TableCell>
              <TableCell>
                {blockers > 0 ? (
                  <Chip tone="bad">{blockers}</Chip>
                ) : (
                  <span className="text-xs text-muted-foreground">0</span>
                )}
              </TableCell>
```

Update the row-destructuring in the `.map()` call to pull the two new fields: `{rows.map(({ repo, summary, sparkline, missionCount, blockers }) => {`.

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 8: Run the full test suite**

Run: `cd apps/web && pnpm vitest run`
Expected: all existing tests pass, plus `repo-activity.test.ts`'s tests (4 total once both Task 3 and this task have run).

- [ ] **Step 9: Manual verification**

Load `/repos` in the dev server and confirm the rollup strip renders with real counts and the table's new Missions/Blockers columns line up correctly. If the sandbox can't reach real connected repos/missions, say so explicitly.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/repo-activity.ts apps/web/src/lib/repo-activity.test.ts apps/web/src/app/\(app\)/repos/page.tsx apps/web/src/components/repos-table.tsx
git commit -m "feat(web): add a rollup strip and per-repo mission/blocker counts to /repos"
```
