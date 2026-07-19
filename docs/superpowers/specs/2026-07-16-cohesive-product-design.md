# Cohesive Product: Two Work Modes, One Factory — Design

Date: 2026-07-16
Status: approved (brainstorm complete)
Scope: product-wide information architecture, in three shippable phases

## Thesis

Forge is one engine with two ways work enters it:

- **Goal-based work (campaigns)** — "do X across these repos." Authored
  intent, planned into Tasks, reviewed, runs to completion. Episodic.
  Surface: `/missions` + the composer.
- **Issue-based work (flow)** — "here's my repo's backlog, work these
  issues." Continuous, per-issue opt-in, never "done." Surface: `/repos`
  + standing missions.

The data model already reflects this unity (a standing mission is a Mission
with `workspaceRepo` set; both modes produce Tasks, budgets, Ledger
entries). The product does not — it currently reads as two apps sharing a
database. This design makes the two modes explicit, connected, and visibly
the same factory.

**North star for the issue-based mode:** the operator-console reference
screenshot (lgrammel's tool) — dense, always-on, controls at hand: issue
list with workflow pills, per-issue attempt tabs, PR chips, file
browser, live log, repo-level Deactivate/Manual/Refresh/GitHub controls.
The Live Run View work (2026-07-16 spec) already delivered the log/file
foundations; Phase B builds the rest of the console around them.

## Naming and mental model (decided once, applied everywhere)

- **Mission** stays the engine term (PRD, ledger, API — no churn).
- **Missions** (sidebar/UI) = the goal-based surface. The sidebar label
  "Dashboard" is retired (it pointed at `/missions` and lied).
- **Repos** = the issue-based surface.
- **Standing missions stop masquerading as campaigns**: superseded by
  Mission Hierarchy (2026-07-16 spec) — there's no longer a single
  "standing mission" per repo to badge. Each issue worked is its own real
  Mission (an "Issue · owner/repo#N" row wherever missions are listed,
  linking to its repo's workspace); the repo's container mission is a
  pure envelope that's never listed anywhere.
- **Chat** repositions as "Ask Forge" — an assistant entry point, not a
  third work mode. Stays in the sidebar; not featured on Home. (Its
  `/v1/messages` backend gap is a separate, known concern — out of scope.)

## Phase A — IA core (Home, navigation, missions-list split)

### Home (`/home`) — the cohesion device

New page; becomes the post-login landing. Shows the whole factory in one
place, both modes, every row deep-linking into existing detail pages:

1. **Now running** — active Tasks across both modes (statuses: `running`,
   `dispatching`, `opening_pr`, `awaiting_ci`, `awaiting_verify`,
   `awaiting_ai_review`, `merging`). Row: repo, issue ref or mission name,
   `TaskStatusBadge`, started time. Links to the Task detail page.
2. **Needs you** — Tasks in `awaiting_review`, `failed`, or halted
   (`haltReason` set), plus missions paused by budget. The operator's
   queue. Links to Task/Mission pages.
3. **Recent outcomes** — most recent terminal results (merged PRs,
   resolved reproduce verdicts), last ~10.
4. **Your repos** — compact cards from `listUserRepos`, each showing
   DB-derived activity (active / total Tasks for that repo — **not** live
   GitHub issue counts, which would cost one API call per repo per load).
   Links to repo hubs. Empty state → Setup.

Data: all queries exist or are simple joins (tasks ↔ missions by
`userId`; ledger by recency; `listUserRepos`). No schema changes.

Onboarding rule: `/home` server component redirects to `/setup` when the
user has no GitHub installation; otherwise renders (empty sections show
pointers: no missions → composer, no repos → Setup).

### Navigation

Sidebar: **Home / Repos / Missions / Chat / Setup** (in that order).
- "Dashboard" label → "Missions".
- Forge logo → `/home`.
- Post-auth redirects (login, signup, GitHub OAuth callbackURL) → `/home`.

### Missions list = campaigns by default

- Shipped as originally designed here, then superseded by Mission
  Hierarchy (2026-07-16 spec, Phases 1-2): `/missions` first shipped
  filtering to campaigns by default with a "Show standing missions"
  toggle. Once issue leaves became real Missions in their own right
  (not a shared container's tasks), that toggle became a **kind filter**
  (All / Campaigns / Issues) defaulting to **All** — both kinds are
  first-class rows now, so there's less reason to hide either.
- Every mission row states its shape, derived from existing fields:
  "Fleet · N repos" (targetRepos length > 1), "Single repo · owner/name",
  "Triage · <issueQuery>" (plannerStrategy = triage, no workspaceRepo), or
  "Issue · owner/repo#N" (issueRef set) linking to that repo's workspace.

### Cross-links (minimum connective tissue, Phase A scope)

- Composer accepts `?repo=owner/name` — preselects the Single repo card
  and pre-fills the repo picker. (Primary consumer is Phase B's hub
  header; shipping the param support in Phase A keeps B's change purely
  additive and lets any Phase A surface link to a pre-filled composer.)
- Triage mission issue view (`/missions/[id]/issues`) gains a "view in
  repo workspace" link when the mission has exactly one target repo;
  the repo workspace already links back via "view mission."

## Phase B — the repo operator console

`/repos/[owner]/[repo]` grows from "issue list" into the repo's factory
floor, per the north-star reference.

**Reconciled with Mission Hierarchy Phases 1-2 (shipped since this
section was first written):** there is no longer one "standing mission"
per repo owning every issue's tasks directly. Each repo has a **container**
mission (a pure budget/concurrency envelope, owns no tasks, never listed)
and one **issue leaf mission** per issue actually worked (a real Mission,
owns its own tasks). Everywhere below that used to say "the standing
mission," read "the repo's container mission" — same UI surface, updated
underneath.

### Repo-level controls (header toolbar)

- **Deactivate / Activate** — pauses/resumes the repo's container mission.
  This needs real teeth it didn't have before Mission Hierarchy: today,
  pausing a mission has no effect on its *children's* dispatch eligibility
  — each issue leaf mission's own `status` independently governs whether
  the dispatcher claims its tasks, and the container's status was never
  checked. The dispatcher gains a check: before claiming a leaf mission's
  tasks, look up its container (already fetched for the concurrency-cap
  computation — see Mission Hierarchy Phase 1's `computeContainerCaps`)
  and skip claiming entirely if the container's status isn't `running`.
  Deactivating doesn't touch any child mission's own status — only what
  the dispatcher is willing to claim.
- **Manual** — trigger a tick on demand (existing `POST /tick` endpoint;
  server action wraps it).
- **Refresh** — re-fetch issues from GitHub.
- **GitHub** — deep link to the repo.
- **Run a goal on this repo →** — the escalation path to goal-mode:
  `/missions/new?repo=owner/name`.

### Tabs

- **Issues** — the existing workspace, upgraded (below).
- **Activity** — every Task that has touched this repo from either mode
  (`tasks.repo` already exists; campaign tasks appear here too). This tab
  is where the two modes visibly meet.
- **Settings** — the container mission's knobs surfaced in place: budget
  cap, concurrency cap, AI review, self-verify. Edits the container row
  directly; no new concepts.

### Issues tab upgrades

- **"Next" marker** — mark issues as queued-for-work without dispatching;
  clicking "Work on it" consumes the mark. Decided: a `nextIssueRefs:
  string[]` JSON column on the container mission (nullable, defaults
  empty) — toggled from the issue list, cleared for an issueRef the
  moment `workOnIssue` is called for it. No new table; the container
  already exists per repo and this is the only place per-repo curation
  state like this belongs.
- **Inactive section** — closed/terminal issues collapse to the bottom.
- **Attempt history tabs** — fixes a real latent bug, now more precisely
  scoped than originally written: Mission Hierarchy already ensures
  "Work again" reopens the SAME issue leaf mission rather than colliding
  with other issues' tasks (that cross-issue leakage is gone). The
  remaining bug is narrower: `groupTasksByIssue` still assumes one
  reproduce+fix pair per issueRef, so a second "Work again" on the same
  issue mission — which appends a second reproduce+fix task pair to that
  mission's own task list — still overwrites the first pair in the
  grouping map. Rework grouping to be attempt-index-aware within one
  mission's tasks (pair reproduce/fix tasks by creation order into
  attempts, not by kind alone): each pair becomes an attempt tab (Attempt
  1, 2, …), newest active by default.
- **PR chips** in the issue header (`prUrl`/`prNumber` already on fix
  tasks; not currently shown here).
- **Started timestamp + Abort** — abort maps to the adapter's existing
  `cancelSession`, which no UI currently exposes. New server action +
  button on a running attempt.

### File browser

Not new plumbing — reuses the Live Run View work's synthesized file tabs
(prompt/agent.log/console.log/status.json), rendered here as a real
Name/Modified/Size table instead of tabs, matching the reference's
layout. Same underlying data source, no new sandbox/file-access code.

### Deliberately not copied from the reference

The multi-SDK-version reproduction matrix (V5/V6 columns) — that's the
reference domain's shape. Our verdict's `affectedVersions` field already
carries equivalent data when reported, rendered as chips.

## Phase C — cohesion polish

- Extend the composer's design language console-wide: `font-title` page
  headers, lime accent as the single interaction color (primary buttons,
  active nav item, selected states). Tokens already exist
  (`--forge-accent-*`).
- Empty-state pass: every dead end points at the next action (no repos →
  Setup; no missions → composer; untouched issue → Work on it).
- Terminology audit across pages/copy for the mode vocabulary above.
- PRD/docs sync (`docs/forge-prd.md` gains the two-modes framing; README
  screenshots/wording).

## Out of scope (deliberate)

- Merging the two modes into one surface — they have genuinely different
  rhythms (author-a-goal vs. opt-in-per-issue).
- Renaming "Mission" product-wide.
- Chat's backend (`/v1/messages` gap) — positioning only.
- Multi-user/org features, tick-stream auth posture (tracked separately
  from the Live Run View review), and the pre-existing lint breakage.

## Phasing and delivery

Each phase is a separate spec-checked implementation plan and SDD run,
shippable alone:

- **Phase A** first — biggest cohesion win per line of code; no schema
  changes; all new reads on existing tables.
- **Phase B** second — the operator-console depth; includes the
  attempt-history grouping fix (a correctness item, not just UI).
- **Phase C** last — polish that would otherwise churn if done before
  A/B settle the surfaces.

## Testing (per phase, detailed in each plan)

- Phase A: pure helpers for the mission-shape label and home-page
  query-shaping get unit tests; page-level checks via typecheck + SSR
  smoke + operator walkthrough.
- Phase B: attempt-aware grouping is pure and unit-tested (the overwrite
  bug gets a regression test); abort/pause server actions tested with
  injectable deps per house pattern.
- Phase C: visual/manual.
