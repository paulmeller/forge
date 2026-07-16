# Mission Hierarchy Phase 2: Missions List + Repo Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/missions` and the Repo Workspace reflect the real container/leaf mission model that Phase 1 built: `/missions` shows every mission (campaigns and issues) by default instead of hiding issues behind a leftover "standing" checkbox, issue rows get an honest `"Issue · owner/repo#123"` label instead of the old `"Standing · repo"`, and Repo Workspace's dead-end "View mission" link becomes "View missions" — a real, repo-scoped filter on the same unified list.

**Architecture:** `mission-shape.ts`'s `isStandingMission` (a name that conflated "has a repo" with "is a container," and is now simply wrong — issue leaves have a repo too but aren't standing in for anything) is replaced by `isIssueMission` (checks `issueRef`, the actual discriminator) and `isContainerMission` (for completeness/future use — containers never reach any of these call sites today, since Phase 1's `listMissions()` already excludes them and containers own no tasks). `missionShapeLabel` switches on `issueRef` instead of `workspaceRepo`. `/missions` gains a `kind` filter (replacing the `standing` toggle) and a `repo` filter (new — what Repo Workspace links to).

**Tech Stack:** Next.js 15 App Router (server components), React 19, Drizzle ORM, vitest.

## Global Constraints

- `isStandingMission` has exactly two consumers: `apps/web/src/app/(app)/missions/page.tsx` and `apps/web/src/lib/home.ts`. Both must be updated in the same task as the rename — this is a hard compile-time coupling, not an optional follow-up.
- A container mission never reaches any code touched in this plan (Phase 1's `listMissions()` already excludes it, and it owns no tasks, so it never appears in `home.ts`'s task-joined queries either). `isContainerMission` is added for completeness per the spec, but no call site in this plan needs to use it defensively — don't add speculative container-guards where the data can't actually contain one.
- The `/missions` page's existing auth posture (`getOptionalUser()`, not `withAuth()`) is a known pre-existing quirk (see Phase A's ledger) — out of scope, do not touch it.
- Existing status/backend/search filters, the progress-pill/sparkline rendering, and the mission-name link to `/missions/[missionId]` are unchanged — this plan only touches the kind/repo filtering and the shape-label rendering.
- Spec: `docs/superpowers/specs/2026-07-16-mission-hierarchy-design.md` (Phase 2 section).
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.

---

### Task 1: `mission-shape.ts` redefinition + `home.ts` consumer fix (TDD)

**Files:**
- Modify: `apps/web/src/lib/mission-shape.ts`
- Modify: `apps/web/src/lib/mission-shape.test.ts`
- Modify: `apps/web/src/lib/home.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ShapeInput = Pick<Mission, 'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery' | 'issueRef'>;
  function isCampaignMission(mission: Pick<Mission, 'workspaceRepo'>): boolean;                          // unchanged
  function isContainerMission(mission: Pick<Mission, 'workspaceRepo' | 'issueRef' | 'parentMissionId'>): boolean; // new
  function isIssueMission(mission: Pick<Mission, 'issueRef'>): boolean;                                  // replaces isStandingMission
  function missionShapeLabel(mission: ShapeInput): string;                                               // now keys off issueRef, not workspaceRepo
  ```
- Consumes (in `home.ts`): `isIssueMission` (this task).

- [ ] **Step 1: Write the failing tests**

Replace `apps/web/src/lib/mission-shape.test.ts` in full:

```ts
import { describe, expect, it } from 'vitest';

import {
  isCampaignMission,
  isContainerMission,
  isIssueMission,
  missionShapeLabel,
  type ShapeInput,
} from './mission-shape';

function shape(over: Partial<{
  workspaceRepo: string | null;
  targetRepos: string[] | null;
  plannerStrategy: 'rule-based' | 'llm' | 'graph' | 'triage';
  issueQuery: string | null;
  issueRef: string | null;
  parentMissionId: string | null;
}> = {}): ShapeInput & { parentMissionId: string | null } {
  return {
    workspaceRepo: null,
    targetRepos: [],
    plannerStrategy: 'rule-based',
    issueQuery: null,
    issueRef: null,
    parentMissionId: null,
    ...over,
  } as ShapeInput & { parentMissionId: string | null };
}

describe('isCampaignMission', () => {
  it('a mission with no workspaceRepo is a campaign', () => {
    expect(isCampaignMission(shape())).toBe(true);
  });

  it('a mission with workspaceRepo set is not a campaign', () => {
    expect(isCampaignMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
  });
});

describe('isContainerMission', () => {
  it('a mission with workspaceRepo set and no issueRef/parentMissionId is a container', () => {
    expect(
      isContainerMission(shape({ workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null })),
    ).toBe(true);
  });

  it('a mission with issueRef set is not a container, even with workspaceRepo set', () => {
    expect(
      isContainerMission(
        shape({ workspaceRepo: 'acme/api', issueRef: 'acme/api#1', parentMissionId: 'msn_x' }),
      ),
    ).toBe(false);
  });

  it('a campaign (no workspaceRepo) is not a container', () => {
    expect(isContainerMission(shape())).toBe(false);
  });
});

describe('isIssueMission', () => {
  it('a mission with issueRef set is an issue mission', () => {
    expect(isIssueMission(shape({ issueRef: 'acme/api#42' }))).toBe(true);
  });

  it('a mission with no issueRef is not an issue mission', () => {
    expect(isIssueMission(shape())).toBe(false);
    expect(isIssueMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
  });
});

describe('missionShapeLabel', () => {
  it('labels an issue mission by its issueRef, regardless of other fields', () => {
    expect(
      missionShapeLabel(
        shape({
          workspaceRepo: 'acme/api',
          issueRef: 'acme/api#42',
          plannerStrategy: 'triage',
          targetRepos: ['acme/api'],
        }),
      ),
    ).toBe('Issue · acme/api#42');
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
Expected: FAIL — `isContainerMission`/`isIssueMission` are not exported, and the "issue mission" label test doesn't match the old `"Standing · ..."` output.

- [ ] **Step 3: Rewrite the implementation**

Replace `apps/web/src/lib/mission-shape.ts` in full:

```ts
import type { Mission } from '@forge/db';

export type ShapeInput = Pick<
  Mission,
  'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery' | 'issueRef'
>;

/** A campaign mission is anything NOT tied to a repo. */
export function isCampaignMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !mission.workspaceRepo;
}

/**
 * A container mission (workspaceRepo set, no issueRef, no parent) is a pure
 * budget/concurrency envelope for a repo's issue missions — it owns no
 * tasks and is never listed anywhere (Phase 1's listMissions() already
 * excludes it). Defined here for completeness; no call site in this
 * codebase needs to defensively check for one today.
 */
export function isContainerMission(
  mission: Pick<Mission, 'workspaceRepo' | 'issueRef' | 'parentMissionId'>,
): boolean {
  return !!mission.workspaceRepo && !mission.issueRef && !mission.parentMissionId;
}

/** An issue mission is a real Mission scoped to one specific GitHub issue. */
export function isIssueMission(mission: Pick<Mission, 'issueRef'>): boolean {
  return !!mission.issueRef;
}

/** One-line description of what a mission targets, for list rows and badges. */
export function missionShapeLabel(mission: ShapeInput): string {
  if (mission.issueRef) return `Issue · ${mission.issueRef}`;

  if (mission.plannerStrategy === 'triage') {
    return mission.issueQuery ? `Triage · ${mission.issueQuery}` : 'Triage';
  }

  const repos = mission.targetRepos ?? [];
  if (repos.length === 0) return 'Campaign';
  if (repos.length === 1) return `Single repo · ${repos[0]}`;
  return `Fleet · ${repos.length} repos`;
}
```

- [ ] **Step 4: Fix `home.ts`'s consumer of the renamed function**

`home.ts`'s `queryTasksByStatus` currently selects `workspaceRepo` from the joined `missions` table purely to compute `isStanding` via the old `isStandingMission`. Since every task in this query's result set belongs to either a campaign or an issue leaf mission (never a container — containers own no tasks by construction), the correct replacement is to select `issueRef` instead and use the new `isIssueMission`.

Change the import:

```ts
import { isStandingMission } from './mission-shape';
```

to:

```ts
import { isIssueMission } from './mission-shape';
```

Change the select list inside `queryTasksByStatus`:

```ts
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      workspaceRepo: missions.workspaceRepo,
    })
```

to:

```ts
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      issueRef: missions.issueRef,
    })
```

Change the row-mapping:

```ts
  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isStanding: isStandingMission({ workspaceRepo: r.workspaceRepo }),
  }));
```

to:

```ts
  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isStanding: isIssueMission({ issueRef: r.issueRef }),
  }));
```

(`HomeTaskRow.isStanding`'s field name is left as-is — `/home`'s `TaskRow` component and its "Standing" badge copy are unchanged in this plan; only the underlying predicate that computes the boolean is corrected. Renaming the field itself is Phase 3/polish territory, not this task's job.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- mission-shape`
Expected: PASS (10 tests: 2 isCampaignMission + 3 isContainerMission + 2 isIssueMission + 5 missionShapeLabel).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 7: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass (this confirms nothing else in the codebase still references `isStandingMission`).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/mission-shape.ts apps/web/src/lib/mission-shape.test.ts apps/web/src/lib/home.ts
git commit -m "feat(missions): isStandingMission -> isIssueMission/isContainerMission, issueRef-based shape label"
```

---

### Task 2: `MissionFilters` — kind pills replace the standing toggle

**Files:**
- Modify: `apps/web/src/components/mission-filters.tsx`

**Interfaces:** none new — `MissionFilters` still takes no props; only its internal URL params change (`standing` removed, `kind` added).

- [ ] **Step 1: Replace the standing checkbox with kind pills**

In `apps/web/src/components/mission-filters.tsx`, add a `KINDS` constant next to the existing `STATUSES`/`BACKENDS`:

```ts
const STATUSES = ['draft', 'planning', 'running', 'paused', 'completed', 'cancelled'] as const;
const BACKENDS = ['managed-agents', 'gateway'] as const;
const KINDS = ['all', 'campaigns', 'issues'] as const;
```

Inside the component, add the active-kind read next to the existing `activeStatuses`/`activeBackend`/`search` reads:

```ts
  const activeStatuses = params.get('status')?.split(',').filter(Boolean) ?? [];
  const activeBackend = params.get('backend') ?? '';
  const search = params.get('q') ?? '';
  const activeKind = params.get('kind') || 'all';
```

Replace the standing checkbox block:

```tsx
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

with:

```tsx
      {/* Kind pills */}
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => updateParam('kind', k === 'all' ? '' : k)}
          className={`rounded-full border px-2.5 py-1 text-[11px] capitalize transition ${
            activeKind === k
              ? 'border-foreground bg-foreground text-background'
              : 'border-border bg-card text-muted-foreground hover:border-foreground/30'
          }`}
        >
          {k}
        </button>
      ))}
```

- [ ] **Step 2: Make the Clear button account for `kind` and `repo`**

Change the Clear button's visibility condition:

```tsx
      {(activeStatuses.length > 0 || activeBackend || search) && (
```

to:

```tsx
      {(activeStatuses.length > 0 ||
        activeBackend ||
        search ||
        activeKind !== 'all' ||
        params.get('repo')) && (
```

(This also fixes a previously-known gap: the old standing toggle didn't make the Clear button appear either — the same fix now covers both `kind` and the new `repo` filter, since Clear already wipes every param via `router.replace('/missions', ...)`.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/mission-filters.tsx
git commit -m "feat(missions): kind filter (All/Campaigns/Issues) replaces the standing toggle"
```

---

### Task 3: `/missions` — default to everything, apply kind + repo filters, new shape-label link

**Files:**
- Modify: `apps/web/src/app/(app)/missions/page.tsx`

**Interfaces:**
- Consumes: `isCampaignMission`, `isIssueMission`, `missionShapeLabel` (Task 1).

- [ ] **Step 1: Update the searchParams type and destructure**

Change:

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

to:

```ts
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string; kind?: string; repo?: string }>;
}) {
  const {
    status: statusFilter,
    backend: backendFilter,
    q: searchQuery,
    kind: kindFilter,
    repo: repoFilter,
  } = await searchParams;
```

- [ ] **Step 2: Replace the default-campaigns-only filter with kind + repo filters**

Change:

```ts
  let allMissions = await listMissions();

  if (showStanding !== '1') {
    allMissions = allMissions.filter(isCampaignMission);
  }
```

to:

```ts
  let allMissions = await listMissions();

  if (kindFilter === 'campaigns') {
    allMissions = allMissions.filter(isCampaignMission);
  } else if (kindFilter === 'issues') {
    allMissions = allMissions.filter(isIssueMission);
  }

  if (repoFilter) {
    allMissions = allMissions.filter((m) => m.workspaceRepo === repoFilter);
  }
```

(No `else` branch for the default "all" case — an unrecognized or absent `kind` value shows everything, matching `MissionFilters`' own `'all'` default.)

- [ ] **Step 3: Update the import**

Change:

```ts
import { isCampaignMission, isStandingMission, missionShapeLabel } from '@/lib/mission-shape';
```

to:

```ts
import { isCampaignMission, isIssueMission, missionShapeLabel } from '@/lib/mission-shape';
```

- [ ] **Step 4: Update `hasFilters`**

Change:

```ts
  const hasFilters = !!(statusFilter || backendFilter || searchQuery);
```

to:

```ts
  const hasFilters = !!(
    statusFilter ||
    backendFilter ||
    searchQuery ||
    (kindFilter && kindFilter !== 'all') ||
    repoFilter
  );
```

- [ ] **Step 5: Update the shape-label rendering**

Change:

```tsx
                      {isStandingMission(mission) ? (
```

to:

```tsx
                      {isIssueMission(mission) ? (
```

(The rest of that conditional block — the `<Link href={`/repos/${mission.workspaceRepo}`}>` vs plain `<p>` — is unchanged; `mission.workspaceRepo` is still correctly set on issue missions, so the href continues to resolve to the right repo workspace.)

- [ ] **Step 6: Update the "Missions" page subtitle**

The current subtitle ("Active and recent fleet operations.") describes only campaigns — now that the page shows both kinds by default, update it:

```tsx
          <p className="mt-0.5 text-sm text-muted-foreground">
            Active and recent fleet operations.
          </p>
```

becomes:

```tsx
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every campaign and issue Forge is working on, across every repo.
          </p>
```

- [ ] **Step 7: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/missions`
Expected: `200` (this page's existing `getOptionalUser()` auth posture is unchanged).
Run: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3100/missions?repo=paulmeller/forge"`
Expected: `200`.

- [ ] **Step 8: Commit**

```bash
git add "apps/web/src/app/(app)/missions/page.tsx"
git commit -m "feat(missions): default to all missions, add kind + repo filters, Issue shape labels"
```

---

### Task 4: Repo Workspace — "View mission" becomes "View missions"

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:** none new — pure link-target change.

- [ ] **Step 1: Update the header link**

Change:

```tsx
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions/${mission.id}`}>View mission</Link>
            </Button>
          ) : null}
```

to:

```tsx
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions?repo=${encodeURIComponent(repo)}`}>View missions</Link>
            </Button>
          ) : null}
```

(`repo` here is the combined `"owner/repoName"` string already computed at the top of this component — `encodeURIComponent` guards against any future repo name containing characters that aren't safe unencoded in a query string, even though GitHub repo names in practice never do.)

- [ ] **Step 2: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/paulmeller/forge`
Expected: `307` or `200`.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): View mission -> View missions, linking to the repo-scoped /missions filter"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every workspace's test suite**

Run: `pnpm test`
Expected: all suites pass across `@forge/web`, `@forge/tick`, `@forge/db`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification**

Ask the operator to confirm, against the real local app (`http://localhost:3100`), using the real repos already in the database (`paulmeller/forge`, `agentstep/product`):

1. `/missions` now shows campaigns AND issue missions by default (no toggle needed) — spot-check that the real issue missions created during Phase 1 (`paulmeller/forge#18`, `#4`, `agentstep/product#6`) all appear.
2. Each issue mission's row shows `"Issue · owner/repo#N"` as a link; clicking it lands on that repo's Workspace.
3. The kind filter pills (All/Campaigns/Issues) correctly narrow the list; "Campaigns" hides every issue row, "Issues" hides every campaign row.
4. Visiting `/repos/paulmeller/forge` and clicking "View missions" lands on `/missions?repo=paulmeller/forge` showing only that repo's issue missions (no campaigns, no other repos' issues).
5. The "Clear" button appears whenever a kind or repo filter is active (not just status/backend/search), and clicking it returns to the unfiltered, default "all missions" view.
6. `/home` is unaffected — its "Standing" badges and links still work the same as before this plan (Task 1 only changed which predicate computes the same boolean, not `/home`'s rendering).

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
