# Cohesive Product Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the IA core of the cohesive-product redesign — a new `/home` cross-mode landing page, restructured sidebar navigation, a campaigns-only `/missions` list with mission-shape labeling, post-auth redirects to Home, and the `?repo=` composer prefill that lets any surface hand off into goal-mode.

**Architecture:** Two new pure/DB-query lib modules (`mission-shape.ts`, `home.ts`) feed a new `/home` page built from patterns already established by the existing `/missions` dashboard-stats code (this plan discovered `/missions/page.tsx` already computes cross-cutting stats — Phase A reuses that pattern rather than duplicating it, and trims `/missions` down to its campaigns-list job). Navigation and redirect changes are small, mechanical edits across a handful of existing files.

**Tech Stack:** Next.js 15 App Router (server components), drizzle, vitest.

## Global Constraints

- No schema changes. Every query in this plan reads existing tables (`missions`, `tasks`, `github_installation_repos`/`github_installations`).
- `/home` requires auth (`withAuth()`, redirects to `/login`) and redirects to `/setup` when the user has no GitHub installation — it's the *post-login* landing, not a public page.
- "Campaign" mission = `workspaceRepo IS NULL`. "Standing" mission = `workspaceRepo IS NOT NULL`. This predicate is defined once (Task 1) and reused everywhere else in this plan and in Phase B.
- The sidebar's Forge logo link, set to `/missions` earlier this session, is superseded by this plan — it now points to `/home`. Don't leave both changes half-applied.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.
- Spec: `docs/superpowers/specs/2026-07-16-cohesive-product-design.md` (Phase A section).

---

### Task 1: `mission-shape.ts` — pure mission-shape helpers (TDD)

**Files:**
- Create: `apps/web/src/lib/mission-shape.ts`
- Test: `apps/web/src/lib/mission-shape.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ShapeInput = Pick<Mission, 'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery'>;
  function isCampaignMission(mission: ShapeInput): boolean;   // !workspaceRepo
  function isStandingMission(mission: ShapeInput): boolean;   // !!workspaceRepo
  function missionShapeLabel(mission: ShapeInput): string;    // "Fleet · 3 repos" | "Single repo · acme/api" | "Triage · <query>" | "Standing · acme/api"
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/mission-shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isCampaignMission, isStandingMission, missionShapeLabel } from './mission-shape';

function shape(over: Partial<{
  workspaceRepo: string | null;
  targetRepos: string[] | null;
  plannerStrategy: string;
  issueQuery: string | null;
}> = {}) {
  return {
    workspaceRepo: null,
    targetRepos: [],
    plannerStrategy: 'rule-based',
    issueQuery: null,
    ...over,
  };
}

describe('isCampaignMission / isStandingMission', () => {
  it('a mission with no workspaceRepo is a campaign', () => {
    expect(isCampaignMission(shape())).toBe(true);
    expect(isStandingMission(shape())).toBe(false);
  });

  it('a mission with workspaceRepo set is standing', () => {
    expect(isCampaignMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
    expect(isStandingMission(shape({ workspaceRepo: 'acme/api' }))).toBe(true);
  });
});

describe('missionShapeLabel', () => {
  it('labels a standing mission by its repo, regardless of other fields', () => {
    expect(
      missionShapeLabel(
        shape({ workspaceRepo: 'acme/api', plannerStrategy: 'triage', targetRepos: ['acme/api'] }),
      ),
    ).toBe('Standing · acme/api');
  });

  it('labels a triage campaign by its issue query', () => {
    expect(
      missionShapeLabel(
        shape({ plannerStrategy: 'triage', issueQuery: 'repo:acme/api is:open label:bug' }),
      ),
    ).toBe('Triage · repo:acme/api is:open label:bug');
  });

  it('labels a single-repo campaign by its one repo', () => {
    expect(missionShapeLabel(shape({ targetRepos: ['acme/api'] }))).toBe('Single repo · acme/api');
  });

  it('labels a multi-repo campaign as Fleet with a count', () => {
    expect(
      missionShapeLabel(shape({ targetRepos: ['acme/api', 'acme/web', 'acme/mobile'] })),
    ).toBe('Fleet · 3 repos');
  });

  it('falls back to a generic label when there are no target repos and no query', () => {
    expect(missionShapeLabel(shape({ targetRepos: [] }))).toBe('Campaign');
    expect(missionShapeLabel(shape({ targetRepos: null }))).toBe('Campaign');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- mission-shape`
Expected: FAIL — cannot resolve `./mission-shape`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/mission-shape.ts`:

```ts
import type { Mission } from '@forge/db';

export type ShapeInput = Pick<Mission, 'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery'>;

/** A campaign mission is anything NOT tied to a repo's standing workspace. */
export function isCampaignMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !mission.workspaceRepo;
}

export function isStandingMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !!mission.workspaceRepo;
}

/** One-line description of what a mission targets, for list rows and badges. */
export function missionShapeLabel(mission: ShapeInput): string {
  if (mission.workspaceRepo) return `Standing · ${mission.workspaceRepo}`;

  if (mission.plannerStrategy === 'triage') {
    return mission.issueQuery ? `Triage · ${mission.issueQuery}` : 'Triage';
  }

  const repos = mission.targetRepos ?? [];
  if (repos.length === 0) return 'Campaign';
  if (repos.length === 1) return `Single repo · ${repos[0]}`;
  return `Fleet · ${repos.length} repos`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- mission-shape`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/mission-shape.ts apps/web/src/lib/mission-shape.test.ts
git commit -m "feat(cohesion): mission-shape helpers (campaign/standing, shape label)"
```

---

### Task 2: `home.ts` — cross-mode data queries

**Files:**
- Create: `apps/web/src/lib/home.ts`

**Interfaces:**
- Consumes: `listUserRepos` (`@/lib/mission-defaults-db`, existing), `db` (`@/lib/db`).
- Produces:
  ```ts
  export type HomeTaskRow = {
    task: Task;              // real Task row (@forge/db)
    missionId: string;
    missionName: string;
    isStanding: boolean;
  };
  export function getNowRunning(userId: string, limit?: number): Promise<HomeTaskRow[]>;
  export function getNeedsYou(userId: string, limit?: number): Promise<HomeTaskRow[]>;
  export function getRecentOutcomes(userId: string, limit?: number): Promise<HomeTaskRow[]>;
  export type RepoActivity = { repo: string; activeCount: number; totalCount: number };
  export function getRepoActivity(userId: string): Promise<RepoActivity[]>;
  ```

- [ ] **Step 1: Write the implementation**

First, read `apps/web/src/app/(app)/missions/page.tsx`'s `getDashboardStats` function (lines ~35-88) to match its join/query style exactly — this file follows the same `tasks.innerJoin(missions).where(eq(missions.userId, userId), ...)` pattern.

Create `apps/web/src/lib/home.ts`:

```ts
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { missions, tasks, type Task } from '@forge/db';

import { db } from './db';
import { isStandingMission } from './mission-shape';
import { listUserRepos } from './mission-defaults-db';

export type HomeTaskRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isStanding: boolean;
};

const NOW_RUNNING_STATUSES = [
  'dispatching',
  'running',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
] as const;

const NEEDS_YOU_STATUSES = ['awaiting_review', 'failed'] as const;

const RECENT_OUTCOME_STATUSES = ['merged', 'resolved'] as const;

async function queryTasksByStatus(
  userId: string,
  statuses: readonly string[],
  limit: number,
  orderByCompletedAt: boolean,
): Promise<HomeTaskRow[]> {
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      workspaceRepo: missions.workspaceRepo,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), inArray(tasks.status, statuses)))
    .orderBy(orderByCompletedAt ? desc(tasks.completedAt) : desc(tasks.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isStanding: isStandingMission({ workspaceRepo: r.workspaceRepo }),
  }));
}

/** Active Tasks across both modes — the "what's happening right now" section. */
export function getNowRunning(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NOW_RUNNING_STATUSES, limit, false);
}

/** Tasks that need a human — awaiting review, or failed. */
export function getNeedsYou(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NEEDS_YOU_STATUSES, limit, false);
}

/** Most recent terminal successes — merged PRs, resolved reproduce verdicts. */
export function getRecentOutcomes(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, RECENT_OUTCOME_STATUSES, limit, true);
}

export type RepoActivity = { repo: string; activeCount: number; totalCount: number };

/**
 * Per-repo Task counts (both modes) for the "Your repos" cards. Counts are
 * DB-derived Task activity, not live GitHub issue counts — the latter would
 * cost one API call per repo per page load.
 */
export async function getRepoActivity(userId: string): Promise<RepoActivity[]> {
  const repos = await listUserRepos(userId);
  if (repos.length === 0) return [];

  const rows = await db
    .select({
      repo: tasks.repo,
      total: sql<number>`count(*)`,
      active: sql<number>`count(*) filter (where ${inArray(tasks.status, NOW_RUNNING_STATUSES)})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), isNotNull(tasks.repo)))
    .groupBy(tasks.repo);

  const byRepo = new Map(rows.map((r) => [r.repo, { active: Number(r.active), total: Number(r.total) }]));
  return repos.map((repo) => ({
    repo,
    activeCount: byRepo.get(repo)?.active ?? 0,
    totalCount: byRepo.get(repo)?.total ?? 0,
  }));
}
```

**Note on the `filter (where ...)` SQL:** libSQL/SQLite supports the `FILTER (WHERE ...)` aggregate clause. If drizzle's `sql` template with an embedded `inArray(...)` builder call inside it doesn't compile to valid SQL when nested this way (it needs to render as a raw boolean expression, not a parameterized drizzle condition object), replace that single `active` column expression with two separate queries instead — one `count(*)` grouped by repo with no filter (`total`), one `count(*)` grouped by repo with a `.where(inArray(tasks.status, NOW_RUNNING_STATUSES))` in addition to the existing where clause (`active`) — then merge the two result sets by `repo` in JS, mirroring the `byRepo` map pattern already written above. Use whichever compiles; don't guess silently, verify with the typecheck and a real query against `local.db` before moving on.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. If the `FILTER (WHERE ...)` construct doesn't typecheck or doesn't run against libSQL, apply the two-query fallback described above and re-verify.

- [ ] **Step 3: Manual query smoke test**

Run this from the repo root to confirm the queries execute against the real local DB without error (adjust the user id to a real one from `SELECT id FROM user LIMIT 1` if needed):

```bash
cd apps/web && npx tsx -e "
import('./src/lib/home.ts').then(async (m) => {
  const uid = process.argv[1];
  console.log('nowRunning', (await m.getNowRunning(uid)).length);
  console.log('needsYou', (await m.getNeedsYou(uid)).length);
  console.log('recentOutcomes', (await m.getRecentOutcomes(uid)).length);
  console.log('repoActivity', await m.getRepoActivity(uid));
});
" -- $(sqlite3 ../../packages/db/local.db "SELECT id FROM user LIMIT 1;")
```

Expected: no thrown errors, plausible counts printed (may be 0s on a fresh DB — that's fine, the point is no query error).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/home.ts
git commit -m "feat(cohesion): cross-mode Task queries for the Home page"
```

---

### Task 3: `/home` page

**Files:**
- Create: `apps/web/src/app/(app)/home/page.tsx`

**Interfaces:**
- Consumes: `getNowRunning`/`getNeedsYou`/`getRecentOutcomes`/`getRepoActivity` (Task 2), `missionShapeLabel` (Task 1), `withAuth` (existing), `TaskStatusBadge` (existing, `@/components/task-status-badge`), `githubInstallations` table (existing, for the no-installation redirect check — mirror the exact query `apps/web/src/app/(app)/setup/page.tsx` already uses).

- [ ] **Step 1: Write the page**

First read `apps/web/src/app/(app)/setup/page.tsx`'s installation-check query (the `db.select().from(githubInstallations).where(eq(githubInstallations.userId, user.id))` block) to reuse the identical check for the redirect-to-Setup gate.

Create `apps/web/src/app/(app)/home/page.tsx`:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskStatusBadge } from '@/components/task-status-badge';
import { db } from '@/lib/db';
import {
  getNeedsYou,
  getNowRunning,
  getRecentOutcomes,
  getRepoActivity,
  type HomeTaskRow,
} from '@/lib/home';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

function TaskRow({ row }: { row: HomeTaskRow }) {
  const { task, missionName, isStanding } = row;
  const label = task.issueRef ?? missionName;
  return (
    <Link
      href={`/missions/${task.missionId}/tasks/${task.id}`}
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{label}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{task.repo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isStanding ? (
          <Badge variant="outline" className="text-[10px]">
            Standing
          </Badge>
        ) : null}
        <TaskStatusBadge status={task.status} haltReason={task.haltReason} />
      </div>
    </Link>
  );
}

function Section({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: HomeTaskRow[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          rows.map((row) => <TaskRow key={row.task.id} row={row} />)
        )}
      </CardContent>
    </Card>
  );
}

export default async function HomePage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .limit(1);
  if (!installation) redirect('/setup');

  const [nowRunning, needsYou, recentOutcomes, repoActivity] = await Promise.all([
    getNowRunning(user.id),
    getNeedsYou(user.id),
    getRecentOutcomes(user.id),
    getRepoActivity(user.id),
  ]);

  return (
    <main className="container max-w-[1400px] py-10">
      <div className="mb-8">
        <h1 className="font-title text-3xl uppercase tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything running across your repos and missions.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Now running" rows={nowRunning} empty="Nothing running right now." />
        <Section title="Needs you" rows={needsYou} empty="Nothing waiting on you." />
        <Section
          title="Recent outcomes"
          rows={recentOutcomes}
          empty="No merged PRs or resolved issues yet."
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your repos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {repoActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repos connected yet.{' '}
                <Link href="/setup" className="underline underline-offset-2">
                  Connect repos in Setup
                </Link>
                .
              </p>
            ) : (
              repoActivity.map(({ repo, activeCount, totalCount }) => {
                const [owner, name] = repo.split('/');
                return (
                  <Link
                    key={repo}
                    href={`/repos/${owner}/${name}`}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 font-mono text-sm hover:bg-accent"
                  >
                    <span className="truncate">{repo}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {activeCount > 0 ? `${activeCount} active · ` : ''}
                      {totalCount} total
                    </span>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/home`
Expected: `307` (auth redirect; a 500 means a compile/runtime error — check `curl -s http://localhost:3100/home | head -80` and fix).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/home/page.tsx"
git commit -m "feat(cohesion): /home cross-mode landing page"
```

---

### Task 4: Sidebar navigation restructure

**Files:**
- Modify: `apps/web/src/components/session-sidebar.tsx`

**Interfaces:** none — pure navigation wiring.

- [ ] **Step 1: Update the logo link and nav list**

In `apps/web/src/components/session-sidebar.tsx`:

Change the logo link (currently `href="/missions"`, set earlier this session) to `/home`:

```tsx
        <Link href="/home" className="text-sm font-bold tracking-tight">
          Forge
        </Link>
```

Change the `<nav>` block from:

```tsx
        <NavLink href="/repos">Repos</NavLink>
        <NavLink href="/missions">Dashboard</NavLink>
        <NavLink href="/chat">Chat</NavLink>
        <NavLink href="/setup">Setup</NavLink>
```

to:

```tsx
        <NavLink href="/home">Home</NavLink>
        <NavLink href="/repos">Repos</NavLink>
        <NavLink href="/missions">Missions</NavLink>
        <NavLink href="/chat">Chat</NavLink>
        <NavLink href="/setup">Setup</NavLink>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/session-sidebar.tsx
git commit -m "feat(cohesion): sidebar gains Home, Dashboard renamed to Missions"
```

---

### Task 5: Post-auth redirects point to `/home`

**Files:**
- Modify: `apps/web/src/app/(app)/login/page.tsx`
- Modify: `apps/web/src/app/(app)/signup/page.tsx`

**Interfaces:** none — pure redirect-target wiring.

- [ ] **Step 1: Update login**

In `apps/web/src/app/(app)/login/page.tsx`: change `router.push('/repos')` (email/password success) to `router.push('/home')`, and `callbackURL: '/repos'` (GitHub sign-in) to `callbackURL: '/home'`.

- [ ] **Step 2: Update signup**

Make the identical two changes in `apps/web/src/app/(app)/signup/page.tsx`.

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/home`
Expected: `307`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/login/page.tsx" "apps/web/src/app/(app)/signup/page.tsx"
git commit -m "feat(cohesion): land on /home after sign-in, not /repos"
```

---

### Task 6: Missions list — campaigns by default, shape labels, standing badge

**Files:**
- Modify: `apps/web/src/app/(app)/missions/page.tsx`
- Modify: `apps/web/src/components/mission-filters.tsx`

**Interfaces:**
- Consumes: `isCampaignMission`, `isStandingMission`, `missionShapeLabel` (Task 1).

- [ ] **Step 1: Add the "Show standing missions" toggle to `MissionFilters`**

In `apps/web/src/components/mission-filters.tsx`, add a `standing` boolean param following the exact same `updateParam` pattern already used for `status`/`backend`/`q`. Add after the existing backend-pills block (find it — the file continues past what's shown in the excerpt read during planning; read the full file first):

```tsx
      <span className="mx-1 h-4 w-px bg-border" />

      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          className="accent-checkbox h-3.5 w-3.5"
          checked={params.get('standing') === '1'}
          onChange={(e) => updateParam('standing', e.target.checked ? '1' : '')}
        />
        Show standing missions
      </label>
```

- [ ] **Step 2: Filter to campaigns by default in the page**

In `apps/web/src/app/(app)/missions/page.tsx`:

Add the import: `import { isCampaignMission, isStandingMission, missionShapeLabel } from '@/lib/mission-shape';`

Add `standing` to the destructured `searchParams` type and variable:

```ts
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string; standing?: string }>;
}) {
  const {
    status: statusFilter,
    backend: backendFilter,
    q: searchQuery,
    standing: showStanding,
  } = await searchParams;
```

Right after `let allMissions = await listMissions();`, add the default campaigns-only filter:

```ts
  if (showStanding !== '1') {
    allMissions = allMissions.filter(isCampaignMission);
  }
```

In the table body, add the shape label under the mission name (inside the existing `<TableCell className="max-w-[300px]">`, right after the closing `</Link>`). Standing rows render their label as a link straight to the repo workspace (the spec's "Standing · owner/repo" badge); campaign rows render plain text:

```tsx
                      {isStandingMission(mission) ? (
                        <Link
                          href={`/repos/${mission.workspaceRepo}`}
                          className="mt-0.5 block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          {missionShapeLabel(mission)}
                        </Link>
                      ) : (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {missionShapeLabel(mission)}
                        </p>
                      )}
```

(`Link` from `next/link` is already imported in this file for the mission-name links — no new import needed beyond the `mission-shape` one above.)

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/missions`
Expected: `200` (this page uses `getOptionalUser`, not `withAuth` — confirm this stays true, don't change its auth posture as part of this task).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/missions/page.tsx" apps/web/src/components/mission-filters.tsx
git commit -m "feat(cohesion): missions list defaults to campaigns, adds shape labels"
```

---

### Task 7: Composer `?repo=` prefill

**Files:**
- Modify: `apps/web/src/app/(app)/missions/new/page.tsx`
- Modify: `apps/web/src/app/(app)/missions/new/new-mission-form.tsx`
- Modify: `apps/web/src/app/(app)/missions/new/repo-picker.tsx`

**Interfaces:**
- Produces: `RepoPicker` gains `initialRepo?: string`; `NewMissionForm` gains `initialRepo?: string` and passes it through; `NewMissionPage` reads `?repo=` from `searchParams`.

- [ ] **Step 1: `RepoPicker` accepts an initial value**

In `apps/web/src/app/(app)/missions/new/repo-picker.tsx`, change the props type and the two `useState` initializers:

```tsx
export function RepoPicker({
  mode,
  availableRepos,
  error,
  initialRepo,
}: {
  mode: 'single' | 'multi';
  availableRepos: string[];
  error?: string;
  initialRepo?: string;
}) {
  const [selected, setSelected] = useState<string[]>(initialRepo ? [initialRepo] : []);
  const [freeText, setFreeText] = useState(initialRepo ?? '');
```

No other changes in this file — the rest of the component already works off `selected`/`freeText`.

- [ ] **Step 2: `NewMissionForm` accepts and forwards `initialRepo`**

In `apps/web/src/app/(app)/missions/new/new-mission-form.tsx`, add `initialRepo?: string` to the props type/destructure:

```tsx
export function NewMissionForm({
  availableSkills = [],
  availableRepos = [],
  defaults,
  initialRepo,
}: {
  availableSkills?: SkillOption[];
  availableRepos?: string[];
  defaults: MissionDefaults;
  initialRepo?: string;
}) {
```

Pass it to `RepoPicker`:

```tsx
        <RepoPicker
          mode={missionType === 'fleet' ? 'multi' : 'single'}
          availableRepos={availableRepos}
          error={repoError ?? state.fieldErrors?.targetRepos}
          initialRepo={initialRepo}
        />
```

(`missionType` already defaults to `'single'`, so no change needed there — a `?repo=` param naturally lands on the Single repo card, matching the spec's "preselects the Single repo card" requirement.)

- [ ] **Step 3: Page reads `?repo=` and passes it down**

In `apps/web/src/app/(app)/missions/new/page.tsx`:

```tsx
export default async function NewMissionPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>;
}) {
  const { repo } = await searchParams;
  const user = await withAuth();
  const [skills, defaults, availableRepos] = await Promise.all([
    listSkills(),
    resolveMissionDefaults(user.id),
    listUserRepos(user.id),
  ]);

  return (
    <main className="container max-w-3xl py-10">
      <div className="mb-8">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/missions">&larr; Back to missions</Link>
        </Button>
        <h1 className="font-title text-3xl uppercase tracking-tight">New Mission</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the work. Forge plans it into Tasks you review before anything dispatches.
        </p>
      </div>
      <NewMissionForm
        availableSkills={skills.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        }))}
        availableRepos={availableRepos}
        defaults={defaults}
        initialRepo={repo}
      />
    </main>
  );
}
```

- [ ] **Step 4: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3100/missions/new?repo=acme/api"`
Expected: `307`.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/missions/new/page.tsx" "apps/web/src/app/(app)/missions/new/new-mission-form.tsx" "apps/web/src/app/(app)/missions/new/repo-picker.tsx"
git commit -m "feat(cohesion): composer accepts ?repo= prefill for the Single repo card"
```

---

### Task 8: Cross-link — triage mission issues page → repo workspace

**Files:**
- Modify: `apps/web/src/app/(app)/missions/[missionId]/issues/page.tsx`

**Interfaces:** none new — pure conditional link addition.

- [ ] **Step 1: Add the link**

Read the full current file first. Add a link to the repo workspace when the mission targets exactly one repo — place it near the existing `issueQuery` display block (the `{mission.issueQuery && (...)}` block). `mission.targetRepos[0]` is already an `"owner/name"` string, and the repo workspace route is `/repos/[owner]/[repo]`, so it slots directly after `/repos/` with no reformatting:

```tsx
        {mission.targetRepos?.length === 1 ? (
          <p className="mt-2">
            <Link
              href={`/repos/${mission.targetRepos[0]}`}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              View in repo workspace →
            </Link>
          </p>
        ) : null}
```

- [ ] **Step 2: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/[missionId]/issues/page.tsx"
git commit -m "feat(cohesion): link from triage mission issues to its repo workspace"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass, including the new `mission-shape.test.ts`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification (requires the signed-in operator)**

Ask the operator to confirm:

1. Signing in (or visiting the app fresh) lands on `/home`, not `/repos` or `/missions`.
2. `/home` shows the four sections; each section's rows link to the correct Task/Mission detail pages; "Your repos" cards link to `/repos/[owner]/[repo]`.
3. Sidebar shows Home above Repos above Missions (renamed from Dashboard); the Forge logo also goes to `/home`.
4. `/missions` shows only campaign missions by default; checking "Show standing missions" reveals the rest; each row shows its shape label (Fleet/Single repo/Triage/Standing).
5. Visiting `/missions/new?repo=acme/api` (substitute a real connected repo) preselects Single repo with that repo already chosen in the picker.
6. A triage mission's issues page (`/missions/[id]/issues`) with exactly one target repo shows a "View in repo workspace →" link that lands on the matching `/repos/[owner]/[repo]`.

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
