# Repos Page — Missions-Per-Repo View — Design

## Motivation

`/repos` (`apps/web/src/app/(app)/repos/page.tsx`) is currently a bare list of connected repo names with no mission or status information — you have to click into a repo's own workspace page to see anything about what's happening there. The user wants this page to instead surface mission activity directly, grouped per repo, using the same table and columns already used on `/missions`.

Explored via the visual companion (three mockups: a simplified status-rollup row, the real `MissionsTable` sectioned by repo, and a card grid) — the user picked the real-`MissionsTable`-sectioned-by-repo option, then confirmed: only repos with active missions, same columns as `/missions`, nothing more.

## Scope

- Redesign `/repos/page.tsx` only. `/repos/[owner]/[repo]/page.tsx` (the single-repo workspace page) is unchanged.
- Group a user's missions by target repo, rendering the real `MissionsTable` component once per repo section.
- Only repos with at least one mission appear. Repos with zero missions are omitted entirely (confirmed: `/setup` remains the place to see/manage all connected repos regardless of activity).
- No filter bar (`MissionFilters`) on this page — not part of what was approved, left out rather than silently added.
- Fully real, data-wired from the start (not a throwaway mockup) — confirmed by the user.

## Data & Grouping

Reuse `listMissions()` (`apps/web/src/lib/missions.ts:137`) exactly as-is — no changes to the data layer. It already scopes to the authenticated user (`withAuth()` internally) and already excludes internal container missions (its existing `WHERE` clause requires `workspaceRepo IS NULL OR issueRef IS NOT NULL OR parentMissionId IS NOT NULL`), so it returns exactly the same "real, user-visible" missions `/missions` shows today.

Grouping happens in the page component: iterate every mission's `targetRepos: string[]` and add the mission to a `Map<string, Mission[]>` keyed by repo. **Deliberate behavior, not a bug:** a mission can target multiple repos at once (a "campaign" mission), so a multi-repo mission appears in every repo section it targets — it genuinely is active work for each of those repos. The same mission row can therefore appear more than once on the page, once per repo it touches.

For each repo key in the resulting map (sorted alphabetically), compute `rollupMissions(ids)` and `sparklinesForMissions(ids)` (`apps/web/src/lib/rollups.ts`) scoped to just that repo's mission IDs — the exact same functions `/missions` already calls for its single flat list, just invoked once per repo group instead of once for everything. All groups are computed via one `Promise.all` before rendering (each group's rollup/sparkline computation is independent and async).

## Page Structure

```tsx
export default async function ReposPage() {
  const user = await withAuth();
  const missions = await listMissions();

  const missionsByRepo = new Map<string, Mission[]>();
  for (const mission of missions) {
    for (const repo of mission.targetRepos ?? []) {
      const list = missionsByRepo.get(repo) ?? [];
      list.push(mission);
      missionsByRepo.set(repo, list);
    }
  }

  const repos = [...missionsByRepo.keys()].sort();

  if (repos.length === 0) {
    // single top-level empty state — see Empty States below
  }

  const sections = await Promise.all(
    repos.map(async (repo) => {
      const repoMissions = missionsByRepo.get(repo)!;
      const ids = repoMissions.map((m) => m.id);
      const [rollups, sparklines] = await Promise.all([
        rollupMissions(ids),
        sparklinesForMissions(ids),
      ]);
      return { repo, missions: repoMissions, rollups, sparklines };
    }),
  );

  // render: PageShell > PageHeader + one <section> per entry in `sections`,
  // each with a repo-name heading and <MissionsTable ... bare /> underneath.
}
```

Each section renders `<MissionsTable missions={m.missions} rollups={m.rollups} sparklines={m.sparklines} hasFilters={false} bare />` — reusing the already-existing `bare` prop ("skip the outer rounded-border wrapper — for embedding inside a parent panel that already provides one"), so no changes to `missions-table.tsx` are needed at all. The columns (Name, Status, Progress, Activity (24h), Backend, Created) are exactly what `/missions` shows today, unchanged.

`hasFilters={false}` is always correct here since this page has no filter bar and every rendered section is guaranteed to have at least one mission (empty groups are never added to the map in the first place).

## Empty States

- **A repo section**: never actually empty by construction (a repo only gets a section if it has ≥1 mission), so `MissionsTable`'s own "No missions yet" empty state is unreachable here — not a concern to design around further.
- **Zero repos have any mission activity at all**: the whole page shows one top-level empty state (using the existing `Empty`/`EmptyHeader`/`EmptyTitle`/`EmptyDescription` components already imported in the current `page.tsx`), pointing at `/missions/new` to create one, or `/setup` if the user has no connected repos at all yet (distinguish via `listUserRepos(user.id)` — if that's also empty, point at `/setup`; if repos are connected but have zero missions, point at `/missions/new`).

## Testing

- No existing test file covers `repos/page.tsx` today (it's a server component page, consistent with this app's general pattern of not unit-testing page-level components — confirmed earlier this session there are zero `.test.tsx` files anywhere in `apps/web`).
- The one piece of genuinely new logic worth unit-testing is the repo-grouping itself (iterating `targetRepos`, building the `Map`, sorting keys) — this should be extracted into a small, pure, exported helper function, `groupMissionsByRepo(missions: Mission[]): Map<string, Mission[]>`, in a new file `apps/web/src/lib/group-missions-by-repo.ts` (matching the existing naming convention of `lib/mission-list-filters.ts`), so it can be tested directly with plain objects — including the multi-repo-mission duplication case — without needing a live database.
- No changes to `missions-table.tsx`, `rollups.ts`, or `missions.ts` — all reused as-is, so their existing test coverage continues to apply unchanged.

## Explicitly Out of Scope

- `/repos/[owner]/[repo]/page.tsx` (the single-repo workspace page) — completely unchanged.
- A filter bar (`MissionFilters`) on this page.
- Showing repos with zero missions (deferred to `/setup`, which already lists all connected repos regardless of activity).
- Any change to how `targetRepos`/multi-repo campaign missions are modeled or dispatched — this is a read-only display grouping, not a data model change.
