# Repos Page — Missions-Per-Repo View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/repos` so each row shows one repo's aggregated mission activity (Name / Status / Progress / Activity (24h) / Created) instead of today's bare repo-name list.

**Architecture:** Two new pure functions (`groupMissionsByRepo`, `summarizeRepoMissions`) turn a flat `Mission[]` into per-repo groups and summaries; a new `ReposTable` component renders them using the same shadcn `Table` primitives and `Chip`/`Sparkline` visual language `MissionsTable` already uses; `repos/page.tsx` is rewritten to wire the two together. `missions-table.tsx` itself is untouched — this is a new, separate component for a genuinely different row shape (one row per repo, not per mission).

**Tech Stack:** Next.js Server Components, Vitest (plain, no RTL — confirmed zero `.test.tsx` files exist anywhere in `apps/web`), existing shadcn UI primitives.

## Global Constraints

- Status label: `'running'` if any mission in the repo group has a non-terminal `mission.status` (`draft`, `planning`, `running`, `paused`); `'completed'` only when every mission is terminal (`completed`, `cancelled`).
- Progress column counts *missions* by status, not tasks — no `rollupMissions` (task-level rollup) involved anywhere in this feature.
- Activity (24h) is `sparklinesForMissions`'s per-mission 30-length arrays, summed element-wise across each repo's missions.
- Created is the `createdAt` of the most recently created mission in the repo group, not a repo-level timestamp (repos don't have one in this data model).
- A mission targeting multiple repos (`targetRepos.length > 1`) is deliberately counted in every one of those repos' groups — not a bug.
- No changes to `missions-table.tsx`, `rollups.ts`, or `missions.ts`.
- Only repos with ≥1 mission appear on the page; repos with zero missions are omitted entirely.

---

## Task 1: `groupMissionsByRepo` and `summarizeRepoMissions`

**Files:**
- Create: `apps/web/src/lib/group-missions-by-repo.ts`
- Test: `apps/web/src/lib/group-missions-by-repo.test.ts`

**Interfaces:**
- Produces: `groupMissionsByRepo(missions: Mission[]): Map<string, Mission[]>` and `summarizeRepoMissions(missions: Mission[]): { status: 'running' | 'completed'; breakdown: Array<{ status: MissionStatus; count: number }>; mostRecentCreatedAt: Date }`. Both are pure, synchronous, and take plain `Mission[]` — no DB access. Task 2 imports both by name from this file.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/group-missions-by-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Mission, MissionStatus } from '@forge/db';

import { groupMissionsByRepo, summarizeRepoMissions } from './group-missions-by-repo';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_1',
    name: 'Test mission',
    status: 'running',
    backend: 'managed-agents',
    workspaceRepo: null,
    targetRepos: ['acme/api'],
    issueRef: null,
    parentMissionId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  } as Mission;
}

describe('groupMissionsByRepo', () => {
  it('groups missions by their single target repo', () => {
    const a = mission({ id: 'a', targetRepos: ['acme/api'] });
    const b = mission({ id: 'b', targetRepos: ['acme/widgets'] });
    const result = groupMissionsByRepo([a, b]);
    expect(result.get('acme/api')?.map((m) => m.id)).toEqual(['a']);
    expect(result.get('acme/widgets')?.map((m) => m.id)).toEqual(['b']);
  });

  it('a mission targeting multiple repos appears in every one of its repo groups', () => {
    const campaign = mission({ id: 'c', targetRepos: ['acme/api', 'acme/widgets'] });
    const result = groupMissionsByRepo([campaign]);
    expect(result.get('acme/api')?.map((m) => m.id)).toEqual(['c']);
    expect(result.get('acme/widgets')?.map((m) => m.id)).toEqual(['c']);
  });

  it('adds no group for a mission with no target repos', () => {
    const noRepo = mission({ id: 'x', targetRepos: [] });
    const result = groupMissionsByRepo([noRepo]);
    expect(result.size).toBe(0);
  });
});

describe('summarizeRepoMissions', () => {
  it.each([
    ['draft', 'running'],
    ['planning', 'running'],
    ['running', 'running'],
    ['paused', 'running'],
    ['completed', 'completed'],
    ['cancelled', 'completed'],
  ] as Array<[MissionStatus, 'running' | 'completed']>)(
    'a lone mission with status %s summarizes to %s',
    (status, expected) => {
      const result = summarizeRepoMissions([mission({ status })]);
      expect(result.status).toBe(expected);
    },
  );

  it('summarizes to running when at least one mission is non-terminal, even if others are terminal', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'completed' }),
      mission({ id: 'b', status: 'running' }),
    ]);
    expect(result.status).toBe('running');
  });

  it('summarizes to completed only when every mission is terminal', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'completed' }),
      mission({ id: 'b', status: 'cancelled' }),
    ]);
    expect(result.status).toBe('completed');
  });

  it('produces a count breakdown per status', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'running' }),
      mission({ id: 'b', status: 'running' }),
      mission({ id: 'c', status: 'completed' }),
    ]);
    expect(result.breakdown).toEqual(
      expect.arrayContaining([
        { status: 'running', count: 2 },
        { status: 'completed', count: 1 },
      ]),
    );
    expect(result.breakdown).toHaveLength(2);
  });

  it("picks the most recently created mission's createdAt", () => {
    const older = mission({ id: 'a', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = mission({ id: 'b', createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const result = summarizeRepoMissions([older, newer]);
    expect(result.mostRecentCreatedAt).toEqual(newer.createdAt);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/lib/group-missions-by-repo.test.ts`
Expected: FAIL — the module `./group-missions-by-repo` does not exist yet.

- [ ] **Step 3: Implement `group-missions-by-repo.ts`**

Create `apps/web/src/lib/group-missions-by-repo.ts`:

```ts
import type { Mission, MissionStatus } from '@forge/db';

/**
 * Groups missions by every repo they target. A campaign mission spanning
 * multiple repos is deliberately added to each one's group — it genuinely
 * is active/completed work for all of them, not a duplication bug.
 */
export function groupMissionsByRepo(missions: Mission[]): Map<string, Mission[]> {
  const map = new Map<string, Mission[]>();
  for (const mission of missions) {
    for (const repo of mission.targetRepos ?? []) {
      const list = map.get(repo) ?? [];
      list.push(mission);
      map.set(repo, list);
    }
  }
  return map;
}

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(['completed', 'cancelled']);

/**
 * Summarizes one repo's mission group: a single running/completed label
 * (running if anything is still non-terminal), a per-status count
 * breakdown, and the most recently created mission's createdAt. Counts
 * missions, not tasks — no task-level rollup is involved.
 */
export function summarizeRepoMissions(missions: Mission[]): {
  status: 'running' | 'completed';
  breakdown: Array<{ status: MissionStatus; count: number }>;
  mostRecentCreatedAt: Date;
} {
  const status = missions.some((m) => !TERMINAL_MISSION_STATUSES.has(m.status))
    ? 'running'
    : 'completed';

  const counts = new Map<MissionStatus, number>();
  for (const m of missions) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([status, count]) => ({ status, count }));

  const mostRecentCreatedAt = missions.reduce(
    (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
    missions[0]!.createdAt,
  );

  return { status, breakdown, mostRecentCreatedAt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/group-missions-by-repo.test.ts`
Expected: PASS (12 tests: 3 in `groupMissionsByRepo`, 6 from the `it.each` block + 3 more in `summarizeRepoMissions`).

- [ ] **Step 5: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/group-missions-by-repo.ts apps/web/src/lib/group-missions-by-repo.test.ts
git commit -m "feat(web): add groupMissionsByRepo/summarizeRepoMissions pure helpers"
```

---

## Task 2: `ReposTable` component and `/repos` page rewrite

**Files:**
- Modify: `apps/web/src/components/progress-pill.tsx` (export `Chip`)
- Create: `apps/web/src/components/repos-table.tsx`
- Modify: `apps/web/src/app/(app)/repos/page.tsx`

**Interfaces:**
- Consumes: `groupMissionsByRepo`, `summarizeRepoMissions` from Task 1's `@/lib/group-missions-by-repo`; `listMissions()` (`@/lib/missions`, unchanged); `sparklinesForMissions()` (`@/lib/rollups`, unchanged); `listUserRepos()` (`@/lib/mission-defaults-db`, unchanged); `withAuth()` (`@/lib/with-auth`, unchanged).
- Produces: `Chip` now exported from `progress-pill.tsx` (previously module-private). `ReposTable({ rows: RepoRow[] })` exported from the new `repos-table.tsx`, where `RepoRow = { repo: string; summary: { status: 'running' | 'completed'; breakdown: Array<{ status: MissionStatus; count: number }>; mostRecentCreatedAt: Date }; sparkline: number[] }` — this exact shape is what `page.tsx` must construct and pass in.

- [ ] **Step 1: Export `Chip` from `progress-pill.tsx`**

In `apps/web/src/components/progress-pill.tsx`, find the line:

```ts
function Chip({
```

Change it to:

```ts
export function Chip({
```

This is a visibility-only change — nothing about `Chip`'s behavior, props, or the rest of the file changes. No new test needed (this file has no existing test coverage today, consistent with this app's pattern of not unit-testing rendering components — a visibility change to an unchanged function doesn't warrant introducing one now).

- [ ] **Step 2: Run typecheck to confirm the export change is valid**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Create `repos-table.tsx`**

Create `apps/web/src/components/repos-table.tsx`:

```tsx
import Link from 'next/link';

import { Chip } from '@/components/progress-pill';
import { Sparkline } from '@/components/sparkline';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';

import type { MissionStatus } from '@forge/db';

const STATUS_TONE: Record<MissionStatus, 'muted' | 'live' | 'good' | 'bad'> = {
  draft: 'muted',
  planning: 'live',
  running: 'live',
  paused: 'muted',
  completed: 'good',
  cancelled: 'muted',
};

export type RepoRow = {
  repo: string;
  summary: {
    status: 'running' | 'completed';
    breakdown: Array<{ status: MissionStatus; count: number }>;
    mostRecentCreatedAt: Date;
  };
  sparkline: number[];
};

export function ReposTable({ rows }: { rows: RepoRow[] }) {
  const table = (
    <Table className="min-w-[900px]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Activity (24h)</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ repo, summary, sparkline }) => {
          const [owner, name] = repo.split('/');
          return (
            <TableRow key={repo} className="relative cursor-pointer">
              <TableCell className="max-w-[300px]">
                <Link
                  href={`/repos/${owner}/${name}`}
                  className="absolute inset-0"
                  aria-label={repo}
                />
                <span className="block truncate font-mono font-medium">{repo}</span>
              </TableCell>
              <TableCell>
                <Badge variant={summary.status === 'running' ? 'default' : 'secondary'}>
                  {summary.status === 'running' ? 'Running' : 'Completed'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  {summary.breakdown.map(({ status, count }) => (
                    <Chip key={status} tone={STATUS_TONE[status]}>
                      {count} {status}
                    </Chip>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Sparkline values={sparkline} className="text-foreground/70" />
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatDateTime(summary.mostRecentCreatedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  return <Card>{table}</Card>;
}
```

Note `STATUS_TONE` maps `planning`/`running` to `'live'` (still-active work), `completed` to `'good'`, and `draft`/`paused`/`cancelled` to `'muted'` — this drives the breakdown chips' color coding (e.g. a "3 running" chip renders in the same live/active tone `MissionProgressPill` already uses for in-flight task counts).

- [ ] **Step 4: Rewrite `repos/page.tsx`**

Replace the full content of `apps/web/src/app/(app)/repos/page.tsx` with:

```tsx
import Link from 'next/link';

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ReposTable } from '@/components/repos-table';
import { groupMissionsByRepo, summarizeRepoMissions } from '@/lib/group-missions-by-repo';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { listMissions } from '@/lib/missions';
import { sparklinesForMissions } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const user = await withAuth();
  const missions = await listMissions();
  const missionsByRepo = groupMissionsByRepo(missions);
  const repoNames = [...missionsByRepo.keys()].sort();

  if (repoNames.length === 0) {
    const connectedRepos = await listUserRepos(user.id);
    return (
      <PageShell className="max-w-3xl">
        <PageHeader title="Repos" subtitle="Mission activity across your connected repos." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No mission activity yet.</EmptyTitle>
            <EmptyDescription>
              {connectedRepos.length === 0 ? (
                <Link href="/setup">Connect repos in Setup</Link>
              ) : (
                <Link href="/missions/new">Start a new mission</Link>
              )}
              .
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const allIds = missions.map((m) => m.id);
  const sparklines = await sparklinesForMissions(allIds);

  const rows = repoNames.map((repo) => {
    const repoMissions = missionsByRepo.get(repo)!;
    const summary = summarizeRepoMissions(repoMissions);
    const sparkline = repoMissions.reduce<number[]>((acc, m) => {
      const s = sparklines.get(m.id) ?? [];
      return acc.map((v, i) => v + (s[i] ?? 0));
    }, new Array(30).fill(0));
    return { repo, summary, sparkline };
  });

  return (
    <PageShell>
      <PageHeader title="Repos" subtitle="Mission activity across your connected repos." />
      <ReposTable rows={rows} />
    </PageShell>
  );
}
```

Note the empty-state branch keeps `className="max-w-3xl"` on `PageShell` (a narrow, centered message, matching how the old page's empty state looked), while the main table branch uses full-width `PageShell` (no `max-w` override) to match `/missions`' own full-width table presentation.

- [ ] **Step 5: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm -r test`
Expected: PASS — every existing test still green, plus Task 1's 12 new tests.

- [ ] **Step 7: Manual verification (dev server) — required, not optional**

This introduces a brand-new page layout with real data aggregation (grouping, status derivation, sparkline summing) that no automated test exercises end-to-end. Run:

```bash
cd apps/web && pnpm dev
```

Sign in and visit `/repos` in a browser. Confirm:
1. Every repo with at least one mission shows its own row — no zero-mission repos appear.
2. The Status badge reads "Running" for any repo with a non-terminal mission and "Completed" only when every mission for that repo is done.
3. The Progress column shows the count breakdown (e.g. "3 running · 12 completed") with distinct chip colors per status.
4. The Activity sparkline renders (even if flat/empty for a quiet repo — this is expected, not a bug per `Sparkline`'s own empty-state handling).
5. Clicking anywhere on a row navigates to that repo's workspace page (`/repos/{owner}/{repo}`), unchanged from before this task.
6. If you have a real account with zero missions anywhere, confirm the top-level empty state appears and points at the right place (`/setup` vs `/missions/new` depending on whether any repos are connected).

Report the outcome of this manual check in the task report — if anything looks wrong, fix it before marking this task complete.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/progress-pill.tsx apps/web/src/components/repos-table.tsx apps/web/src/app/\(app\)/repos/page.tsx
git commit -m "feat(web): redesign /repos to show missions-per-repo rollup rows"
```

---

## After all tasks: whole-branch review

Once Tasks 1–2 are complete, dispatch a final whole-branch code review (per `superpowers:subagent-driven-development`) covering the full diff against the branch's prior state. Pay particular attention to:
- Does `summarizeRepoMissions` correctly handle every one of the six `MissionStatus` values, not just the two the plan calls out by name in Task 2's UI code (`STATUS_TONE` must have an entry for all six — confirm none are missing, which would be a silent `undefined` tone rather than a compile error since it's a `Record<MissionStatus, ...>` and TypeScript would actually catch a missing key at compile time — but double check the reviewer agrees the `Record` type genuinely enforces this).
- Confirm no other code path anywhere in the app called the old, now-replaced `repos/page.tsx` logic (e.g. any test, storybook-style fixture, or doc referencing its old flat-list shape) that would need updating.
- Confirm the empty-state distinction (`/setup` vs `/missions/new`) reads sensibly and doesn't contradict `/missions`' own setup-banner logic (`getDashboardStats(userId).connectedRepos === 0`, from `missions/page.tsx`) — both should agree on what "zero repos connected" means.
