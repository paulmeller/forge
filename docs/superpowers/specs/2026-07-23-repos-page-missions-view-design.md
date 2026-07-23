# Repos Page — Missions-Per-Repo View — Design

## Motivation

`/repos` (`apps/web/src/app/(app)/repos/page.tsx`) is currently a bare list of connected repo names with no mission or status information — you have to click into a repo's own workspace page to see anything about what's happening there. The user wants this page to instead surface mission activity per repo, styled like `/missions`.

Explored via the visual companion (three mockups: a simplified status-rollup row, the real `MissionsTable` sectioned by repo, and a card grid). The user's final direction, reached after two rounds of refinement past the initial mockup pick, is **one row per repo** (not one row per mission, and not the real `MissionsTable` component reused as-is) — a table styled like `/missions`, where each row aggregates that repo's missions into a summary.

## Scope

- Redesign `/repos/page.tsx` only. `/repos/[owner]/[repo]/page.tsx` (the single-repo workspace page) is unchanged.
- A new table with one row per repo (not per mission), columns: **Name, Status, Progress, Activity (24h), Created**.
- Only repos with at least one mission appear. Repos with zero missions are omitted entirely (`/setup` remains the place to see/manage all connected repos regardless of activity).
- No filter bar (`MissionFilters`) on this page.
- Fully real, data-wired from the start.

## Columns — Exact Semantics

- **Name** — the repo string (`owner/name`), links to `/repos/{owner}/{repo}`.
- **Status** — a single derived label, `'running' | 'completed'`: **"Running"** if any mission in that repo has a non-terminal `mission.status` (`draft`, `planning`, `running`, or `paused` — i.e. there's still work happening or yet to start); **"Completed"** only when every mission in that repo is terminal (`completed` or `cancelled`). This is a new 2-value label, not the real 6-value `MissionStatus` enum, so it can't be passed directly into the existing `MissionStatusBadge` (whose variant map actually assigns `running` and `completed` the *same* visual variant, `'default'` — reusing it as-is would make the two repo-level states visually indistinguishable, which defeats the point of this column). Render with a plain `Badge` using distinct variants per label instead (e.g. `default` for running, `secondary` for completed) — exact variant choice is a small implementation detail for the plan.
- **Progress** — the detailed breakdown behind the Status label: mission counts grouped by `mission.status`, rendered as chips, e.g. **"3 running · 12 completed"**. This counts *missions*, not tasks — no task-level rollup (`rollupMissions`) is involved.
- **Activity (24h)** — the same 30-bucket sparkline concept `/missions` already uses (`sparklinesForMissions`), but aggregated: sum the per-bucket event counts across every mission in that repo, element-wise, into one combined 30-length array per repo.
- **Created** — the `createdAt` of the most recently created mission in that repo (`max(mission.createdAt)` across the group), not the repo's own creation date (repos don't have one in this data model — only missions do).

## Data & Grouping

Reuse `listMissions()` (`apps/web/src/lib/missions.ts:137`) exactly as-is — no changes to the data layer. It already scopes to the authenticated user (`withAuth()` internally) and already excludes internal container missions, so it returns exactly the same "real, user-visible" missions `/missions` shows today.

New pure, exported helper functions in a new file `apps/web/src/lib/group-missions-by-repo.ts`:

```ts
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
    missions[0].createdAt,
  );

  return { status, breakdown, mostRecentCreatedAt };
}
```

**Deliberate behavior, not a bug:** a mission can target multiple repos at once (a "campaign" mission), so it's counted in every repo group it targets — it genuinely is active/completed work for each of those repos.

Sparkline aggregation: `sparklinesForMissions(ids)` already returns `Map<string, number[]>` (30-length arrays) keyed by mission id — for each repo group, sum the arrays for that group's mission IDs element-wise into one combined array. This is small enough to inline in the page component rather than its own helper, but must handle the edge case of a repo whose missions collectively have zero sparkline data (all-zero array, not an error).

## Page Structure

```tsx
export default async function ReposPage() {
  const user = await withAuth();
  const missions = await listMissions();
  const missionsByRepo = groupMissionsByRepo(missions);
  const repoNames = [...missionsByRepo.keys()].sort();

  if (repoNames.length === 0) {
    // single top-level empty state — see Empty States below
  }

  const allIds = missions.map((m) => m.id);
  const sparklines = await sparklinesForMissions(allIds); // computed once for everything, sliced per group below

  const rows = repoNames.map((repo) => {
    const repoMissions = missionsByRepo.get(repo)!;
    const summary = summarizeRepoMissions(repoMissions);
    const combinedSparkline = repoMissions.reduce((acc, m) => {
      const s = sparklines.get(m.id) ?? [];
      return acc.map((v, i) => v + (s[i] ?? 0));
    }, new Array(30).fill(0));
    return { repo, summary, sparkline: combinedSparkline };
  });

  // render: PageShell > PageHeader + a new table component, one row per entry in `rows`.
}
```

A new component, `apps/web/src/components/repos-table.tsx`, renders the table (`Name | Status | Progress | Activity (24h) | Created`), following the same shadcn `Table`/`TableHeader`/`TableRow`/`TableCell` primitives `missions-table.tsx` already uses, reusing `Sparkline` (for Activity) and `formatDateTime`/`formatRelative` (for Created) from the existing `lib/format.ts`. The Progress breakdown chips reuse the `Chip` visual pattern from `components/progress-pill.tsx` (a new small export there, or a sibling component — implementation detail for the plan) rather than inventing new chip styling. `missions-table.tsx` itself is untouched; this is a new, separate component for a genuinely different row shape.

## Empty States

- **Zero repos have any mission activity at all**: the whole page shows one top-level empty state (reusing `Empty`/`EmptyHeader`/`EmptyTitle`/`EmptyDescription`, already imported in the current `page.tsx`), pointing at `/missions/new` to create one, or `/setup` if the user has no connected repos at all yet (check `listUserRepos(user.id)` — if that's also empty, point at `/setup`; if repos are connected but have zero missions, point at `/missions/new`).

## Testing

- `group-missions-by-repo.ts`'s two exported functions (`groupMissionsByRepo`, `summarizeRepoMissions`) are pure and get a dedicated test file with plain mission objects — covering: the multi-repo-mission duplication case, the running/completed status derivation across all six `MissionStatus` values (verifying `draft`/`planning`/`running`/`paused` all count as "running" and only `completed`/`cancelled` count as "completed"), the breakdown counts, and `mostRecentCreatedAt` picking the right mission.
- No existing test file covers `repos/page.tsx` or would cover the new `repos-table.tsx` (consistent with this app's established pattern of not unit-testing page/component rendering — zero `.test.tsx` files exist anywhere in `apps/web`).
- No changes to `missions-table.tsx`, `rollups.ts`, or `missions.ts` — `rollupMissions` (task-level rollup) is not used by this feature at all; only `listMissions()` and `sparklinesForMissions()` are reused, both unchanged.

## Explicitly Out of Scope

- `/repos/[owner]/[repo]/page.tsx` (the single-repo workspace page) — completely unchanged.
- A filter bar (`MissionFilters`) on this page.
- Showing repos with zero missions (deferred to `/setup`).
- Task-level rollup detail (spend, tool calls, etc.) on this page — that stays on the per-mission `/missions` table and each mission's own detail page.
- Any change to how `targetRepos`/multi-repo campaign missions are modeled or dispatched — this is a read-only display grouping, not a data model change.
