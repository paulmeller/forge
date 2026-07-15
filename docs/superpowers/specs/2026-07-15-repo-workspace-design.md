# Repo Workspace — Design

Date: 2026-07-15
Status: approved (brainstorm complete)
Routes: `/repos`, `/repos/[owner]/[repo]` (new); sidebar + default-route changes

## Problem

The dominant single-repo use case is "manage the issues in my repo" — see
issues, pick one, have Forge reproduce and fix it. Today that requires
authoring a Mission (goal prompt, type, issue query) even though the operator
has no "goal" to describe; the mission form is ceremony for this persona.
Reference interaction model: the lgrammel screenshot — issue list left,
per-issue pipeline state right.

## Positioning

Alongside missions, not replacing them — but the workspace becomes the
default landing surface:

- Fleet missions are episodic campaigns; issue triage is daily. Frequency
  picks the front door: post-login lands on `/repos`.
- `/missions` and the composer stay unchanged as the campaign surface —
  fleet-scale orchestration remains the product's differentiator.
- The Mission stays real underneath (auto-created per repo), so budgets,
  guardrails, and the Ledger apply to issue work for free.

## Decisions (settled with operator)

- **"Work on it" dispatches immediately.** Per-issue opt-in IS the curation
  step; no staging batch, no plan-review gate for workspace-originated work.
- **Issue list shows all open issues**, newest first, with a search box and
  label filter chips. No pre-filtering to `label:bug`.
- Curation model is **per-issue opt-in** — unlike composer-created triage
  missions, nothing is enqueued in bulk from a query.

## Surfaces

### Sidebar + routing

- New "Repos" entry in the app sidebar (`SessionSidebar`).
- Post-login default route changes from `/missions` to `/repos`.
- Missions entry unchanged.

### `/repos`

One card per repo from the user's GitHub App installation
(`listUserRepos(userId)`), plus a "Connect more repos in Setup" affordance
linking to `/setup`. Clicking a repo opens its workspace. Empty state (no
installation) mirrors Setup's install prompt.

### `/repos/[owner]/[repo]` — the workspace

Master-detail layout:

- **Left pane:** all open issues (newest first) via GitHub issue search,
  with client-side search box and label chips. Each row: number, title,
  and — when Forge has touched the issue — a pipeline pill (Queued /
  Reproducing / Awaiting review / Merged / Not reproduced / Failed) derived
  from the standing mission's tasks by `issueRef`.
- **Right pane:** issue detail. Untouched issue → title/body + **"Work on
  it"** button. Touched issue → reproduce/fix stage tabs with task status,
  verdict, and links, reusing the data assembly behind
  `/missions/[id]/issues` (the `triage-view` lib).
- Quiet "view mission" link to the standing mission's page.

## Concept: standing vs campaign missions

This design introduces (without new machinery) a conceptual split the
operator explicitly endorsed:

- **Campaign missions** — authored in the composer, finite goal, planned,
  reviewed, run to completion. The existing model.
- **Standing missions** — long-lived, never "complete," fed work
  incrementally by a surface (here: the repo workspace feeding per-issue
  triage pairs). Budgets/guardrails/ledger apply identically.

v1 marks standing missions only via `workspace_repo`. If more standing
kinds emerge later (standing CI-fix, standing dependency bumps), promote
the marker to an explicit `missions.kind` enum then — not now.

## Data model

One schema addition + migration: nullable `missions.workspace_repo` (text).
It is the deterministic lookup key for a repo's standing mission. Composer
missions leave it null.

## Server flow

### `getOrCreateWorkspaceMission(userId, repo)`

1. Select mission where `userId` + `workspaceRepo = repo` + status not in
   `{completed, cancelled}`; return if found.
2. Else insert: name `Issues — {repo}`, auto-goal ("Triage open issues in
   {repo}"), `plannerStrategy: 'triage'`, `workspaceRepo: repo`,
   `targetRepos: [repo]`, status **`running`** immediately (no draft/plan
   phase — per-issue opt-in replaces plan review), agent/GitHub IDs from
   `resolveMissionDefaults(userId)`, no budget cap, AI review and
   self-verify off.

The standing mission appears in `/missions` like any other; pausing it there
pauses workspace dispatch (dispatcher only claims tasks of running missions).

**Reconciler exemption (required):** the tick reconciler auto-completes a
mission when all its tasks are terminal. Standing missions must be exempt —
otherwise finishing the last in-flight issue completes the mission and the
next "Work on it" churns a fresh one. The reconciler's mission-completion
check skips missions with `workspaceRepo` set; everything else (budget
checks, guardrails, task-level reconciliation) still applies to them.

### "Work on it" action

1. `getOrCreateWorkspaceMission`.
2. Insert the gated reproduce→fix pair for that one issue via the existing
   pure builder `buildTriageTaskRows(mission.id, [issue], now)` — no new
   task machinery.
3. Ledger event (`workspace.issue.enqueued` with issueRef and taskIds).
4. UI optimistically shows the "Queued" pill; the tick dispatcher picks the
   reproduce task up next cycle.

### Duplicate guard

- Issue has a non-terminal pair (`queued` / `running` / `awaiting_*` /
  other in-flight states) → button disabled, showing current stage.
- Terminal outcome (merged, failed, abandoned/not-reproduced) → button
  becomes "Work again" and inserts a fresh pair.

## Issue fetching

Reuses `githubSearchIssues` (exported from `triage-planner.ts`) with query
`repo:{owner}/{name} is:issue is:open`. Requires `GITHUB_APP_TOKEN` in the
web app env (same contract as composer triage missions). When unset, the
workspace renders a clear empty state with setup instructions instead of the
issue list — never a crash. Search/label filtering is client-side over the
fetched page(s), inheriting the planner's existing pagination caps.

## Error handling

- Missing `GITHUB_APP_TOKEN` → guidance empty-state (as above).
- GitHub search failure → inline error panel with retry.
- Mission-creation failure (e.g. no agent resolvable anywhere) → inline
  error on the "Work on it" action, pointing at Setup/env config; the
  workspace list itself still renders.
- Dispatch is asynchronous by design; the pill reflects DB state on refresh.

## Testing

- Unit (vitest, injectable-deps pattern per `triage-planner.test.ts`):
  - `getOrCreateWorkspaceMission` idempotency: two calls → one mission;
    completed/cancelled standing missions are not reused.
  - Duplicate-guard predicate: in-flight vs terminal task states → correct
    button state.
- Already covered elsewhere: `buildTriageTaskRows` (pair emission),
  `triage-view` (pill/pipeline derivation), `githubSearchIssues`
  (pagination/truncation).
- Manual: connect repo → workspace lists issues → Work on it → standing
  mission appears in /missions → pill advances after a tick.

## Out of scope

- Replacing `/missions/new` or changing the composer.
- Bulk enqueue from the workspace (query-driven bulk stays on the mission
  side).
- GitHub App installation-token auth for issue search (no helper exists;
  `GITHUB_APP_TOKEN` PAT remains the contract).
- Webhook-driven live updates; the workspace reads current DB/GitHub state
  per load.
