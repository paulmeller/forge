# Mission Hierarchy: Containers and Leaves — Design

Date: 2026-07-16
Status: approved (brainstorm complete)
Scope: data model + backend rework (Phase 1); `/missions` and Repo Workspace
UI updates (Phase 2) — see Phasing.

## Thesis

Every unit of work Forge does — a cross-repo campaign, a single issue being
fixed in one repo — is a Mission. Today the data model only half-believes
this: a campaign is a real Mission, but an issue being worked in a repo is
just a Task pair stuffed inside one shared "standing mission" per repo,
which silently accumulates every issue that repo has ever had worked,
forever. That shared container is the source of several existing rough
edges: the reconciler has a hand-written exemption so it never
auto-completes ("must never auto-complete a mission with workspaceRepo
set" — `packages/db/src/schema.ts`, `apps/tick/src/reconciler.ts:305`),
`/missions` can't show it as a normal row (Phase A's "Standing · repo"
special case), and multiple work attempts on the same issue collide in
`groupTasksByIssue` because they're not actually distinguishable at the
Mission level.

The fix: split the shared standing mission into a **container** (the
repo's budget/concurrency envelope — an empty wallet, never a unit of
work) and one **leaf mission per issue** (a real Mission, same status
lifecycle and progress semantics as a campaign, just usually with 1-2
tasks instead of many). A generic, self-referential `parentMissionId`
implements this — not special-cased to repos, so it can generalize later
if a similar need arises elsewhere.

Everyone still gets the experience that fits how they work: someone
improving one repo just works issues in the Repo Workspace; someone
running a fleet campaign uses the composer — the recursive structure is
plumbing, not something either of them sees.

## Data model

`missions` (`packages/db/src/schema.ts`) gains two nullable columns:

- `parentMissionId: text('parent_mission_id')` — self-referential,
  references `missions.id`. Null for campaigns and for containers
  (containers are always roots). Set for issue leaf missions, pointing at
  their repo's container.
- `issueRef: text('issue_ref')` — same `"owner/repo#123"` format already
  used on `tasks.issueRef` (see `actions.ts`'s
  `` `${repo}#${issue.number}` ``). Null for campaigns and containers; set
  for issue leaf missions, enabling a direct `(userId, workspaceRepo,
  issueRef)` lookup instead of joining through tasks.

Three shapes fall out of the existing columns plus these two new ones:

| Shape | `workspaceRepo` | `issueRef` | `parentMissionId` | Owns tasks? | Listed in `/missions`? |
|---|---|---|---|---|---|
| Campaign (unchanged) | null | null | null | yes | yes |
| Container | set | null | null | **no** | **no — never** |
| Issue leaf | set | set | container's id | yes | yes |

A container never owns tasks and never appears as a row anywhere — it
exists only to hold `concurrencyCap`/budget fields for its children to
share. `workspaceRepo`'s doc comment (currently "must never auto-complete
a mission with this set") is corrected: that constraint now applies only
to containers.

## Behavior changes

### `workOnIssue` (`apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`)

Replaces today's single `getOrCreateWorkspaceMission(userId, repo,
defaults)` with two steps:

1. `getOrCreateRepoContainer(userId, repo, defaults)` — finds or creates
   the repo's container (`workspaceRepo = repo`, `issueRef = null`,
   `parentMissionId = null`), inheriting the same defaults
   `getOrCreateWorkspaceMission` sets today (backend, agentId,
   concurrencyCap, budget fields, `plannerStrategy: 'triage'`, etc.) minus
   anything only meaningful for a task-owning mission.
2. `getOrCreateIssueMission(userId, repo, issueRef, defaults)` — finds or
   creates the issue's leaf (`workspaceRepo = repo`, `issueRef = issueRef`,
   `parentMissionId = container.id`), creating the container first if
   needed. "Work on it" the first time creates this leaf; "Work again"
   finds the same leaf and appends another reproduce→fix task pair to it
   (this is also where the known attempt-history grouping issue now lives
   — scoped to one mission's own tasks, not smeared across a repo's whole
   backlog; still a real gap, now correctly scoped for whoever picks it
   up).

Task inserts (`buildTriageTaskRows` + the transaction) target the leaf
mission's id, not a shared repo mission.

### Dispatcher concurrency (`apps/tick/src/dispatcher.ts`, `claimNextBatch`)

Today, `claimNextBatch(mission)` computes `slots = mission.concurrencyCap -
inflight`, where `inflight` is a count of that mission's own tasks
(`apps/tick/src/dispatcher.ts:95-102`). An issue leaf mission usually has
only 1-2 tasks total, so its own cap is nearly always moot — the real
constraint users want ("don't run more than N issues at once in this
repo") lives at the container level now.

`claimNextBatch` gains a parent-aware check: if `mission.parentMissionId`
is set, additionally compute inflight across **all sibling leaf missions
sharing that parent** (a join through `missions` on `parentMissionId`),
and cap slots at `min(ownSlots, parentContainer.concurrencyCap -
siblingInflight)`. Budget works the same way — a container's effective
spend is the sum of its children's `spentUsd`/`spentTokens`, checked
against the container's `budgetUsd`/`budgetTokens` before dispatch,
mirroring the existing per-mission budget-guard pattern
(`apps/tick/src/budgets.ts`) but rolled up across siblings.

### Reconciler auto-completion (`apps/tick/src/reconciler.ts:305`)

Today's query is `where(and(eq(missions.status, 'running'),
isNull(missions.workspaceRepo)))` — skip every mission with a repo
affiliation. This narrows to skip only **containers** (`workspaceRepo` set
AND `issueRef` null AND `parentMissionId` null) — issue leaf missions,
like campaigns, become eligible for normal auto-completion once all their
tasks reach a terminal state.

## UI changes

### `/missions` (`apps/web/src/app/(app)/missions/page.tsx`)

Lists only leaf missions — campaigns and issue missions — never
containers. Because both are now real Missions with real, usually-small
task lists, the existing `rollupMissions`/`sparklinesForMissions`/status
badge machinery just works for issue rows with no special-casing: a
2-task issue mission's progress pill correctly shows 0%/50%/100% the same
way a campaign's does, which is exactly the "what does Progress mean for
one issue" question this design set out to resolve.

`mission-shape.ts` is redefined around the new columns:

```ts
export function isContainerMission(m: Pick<Mission,'workspaceRepo'|'issueRef'|'parentMissionId'>): boolean {
  return !!m.workspaceRepo && !m.issueRef && !m.parentMissionId;
}
export function isCampaignMission(m: Pick<Mission,'workspaceRepo'|'parentMissionId'>): boolean {
  return !m.workspaceRepo && !m.parentMissionId;
}
export function isIssueMission(m: Pick<Mission,'parentMissionId'>): boolean {
  return !!m.parentMissionId;
}
```

`isStandingMission` and the Phase A "Standing · repo" badge/link are
retired — an issue mission isn't standing in for anything, it's just a
mission whose shape label becomes `` `Issue · ${issueRef}` `` (or similar,
finalized at plan time). The Phase A "Show standing missions" toggle is
replaced with a **kind filter** (All / Campaigns / Issues), defaulting to
All — both kinds are now first-class, equally-weighted rows, so there's
less reason to hide either by default; existing status/backend/search
filters continue to apply uniformly to both kinds since both now share
the same status enum and task-backed semantics.

### Repo Workspace (`apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`)

Replaces "find the one standing mission, list its tasks, `groupTasksByIssue`"
with "find the repo's container (if any), list its child leaf missions,
each with its own tasks" — the rendered shape (one row per issue) barely
changes, since it already rendered per-issue; only the query strategy
changes from grouping-within-one-mission to listing-children. The
header's current "View mission" link (which pointed at the one shared
mission) is replaced with **"View missions"**, linking to
`/missions?repo=owner/name` — a new repo-scoped filter on `/missions`
that shows just this repo's issue missions (`workspaceRepo = repo`),
reusing the unified list instead of a separate detail page.

## Migration

Real, existing data needs a one-time backfill: for each current standing
mission (e.g. `msn_11daa0ea69ef40bb986d` "Issues — agentstep/product",
`msn_00091dd099374af68262` "Issues — paulmeller/forge"), create one
container mission inheriting its budget/concurrencyCap/backend/agentId
settings, then for each distinct `issueRef` among that mission's existing
tasks, create a new leaf mission (`parentMissionId` = the new container,
`workspaceRepo` = the same repo, `issueRef` = that issue) and re-point
those tasks' `missionId` at the new leaf. The original standing mission
row is then either deleted or repurposed as the container itself (cheaper:
repurpose it — clear its owned tasks by re-pointing them, set its
`issueRef`/`parentMissionId` to null, treat it as the container going
forward — avoids orphaning its existing `id` in any ledger events or
external references).

## Testing

- Pure helpers (`mission-shape.ts`'s redefined predicates, any new pure
  parent/child rollup math) get unit tests, matching this project's
  existing convention.
- `claimNextBatch`'s parent-aware slot computation and the reconciler's
  narrowed auto-completion query both get focused unit/integration tests
  (mirroring existing dispatcher/reconciler test patterns), including a
  regression test for the exact scenario the old exemption protected
  against — a container must never be auto-completed even with zero
  children.
- The migration script gets a dry-run mode and is tested against a copy
  of real local data before running for real, given it mutates existing
  Mission/Task rows.

## Out of scope (deliberate)

- `dispatchFromGithub` (`apps/web/src/lib/dispatch-from-github.ts`) — the
  `@forge`-mention-triggered one-shot Mission already behaves like a
  standalone leaf (one Mission, one Task, repo-scoped) and isn't
  currently nested under any container. Whether it should share a repo's
  container (for unified budget/concurrency with `workOnIssue`-created
  issue missions) is a real question, deliberately deferred rather than
  bundled into an already-large change.
- Campaigns gaining their own child missions (e.g. one per repo they
  touch) — the recursive relationship is general enough to support this
  later, but nothing in this design requires it now; campaigns stay flat
  leaves as they are today.
- The attempt-history grouping fix itself (multiple "Work again" attempts
  on the same issue mission colliding in `groupTasksByIssue`) — this
  design correctly re-scopes the bug to a single mission's own task list
  instead of a whole repo's, but doesn't fix the underlying grouping
  logic; that remains a follow-up, now smaller in scope than before.

## Phasing

Given the size, this splits into two implementation plans:

- **Phase 1 — data model + backend.** Schema migration
  (`parentMissionId`, `issueRef`), `getOrCreateRepoContainer` /
  `getOrCreateIssueMission`, dispatcher parent-aware concurrency,
  reconciler exemption narrowing, the data backfill script,
  `mission-shape.ts` redefinition. Testable end-to-end without any UI
  change — Repo Workspace and `/missions` can keep working against the
  new shape with minimal query updates as part of this phase, even before
  their visual treatment changes.
- **Phase 2 — UI.** `/missions`' kind filter (replacing the standing
  toggle) and shape-label update, Repo Workspace's "View mission" →
  "View missions" link and repo-scoped `/missions` filter, any further
  visual polish.

Phase 1's plan is the immediate next deliverable; Phase 2 follows once
Phase 1 is verified, per this project's established phasing convention.
