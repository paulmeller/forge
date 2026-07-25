# v2 UI Polish Batch — Design

## Motivation

A [v2 UI prototype](https://claude.ai/code/artifact/8d106d2c-2ecc-474d-bb9d-a80818a1645f) was built as a static mockup, informed by UI/UX research across coding-agent competitors (Devin, Copilot coding agent, Cursor Background Agents, Jules, Factory.ai, OpenHands, etc.), fleet-scale bulk-change tools (Sourcegraph Batch Changes, CodeRabbit, Graphite), and internal developer portals (Backstage, Port, Cortex, OpsLevel). This spec covers bringing the "quick and medium win" subset of that prototype into the real app: six independent, low-to-medium-risk UI improvements. Two larger pieces from the prototype — a mission fleet-progress burndown chart (needs new time-series infrastructure) and a plan-approval gate before dispatch (needs new schema and dispatch-flow changes) — are explicitly out of scope, to be brainstormed as their own dedicated cycles later.

## Scope

1. Setup page stepper header
2. Chat page suggested-tasks landing state
3. Repo workspace identity zone
4. Merge-state stepper (CI → Merge)
5. Severity-tiered run output ("Needs attention" / "Activity")
6. Repos page rollup strip + per-repo table reshape

## Out of Scope

- Mission fleet-progress burndown chart (needs a new time-series data source — daily snapshots or retroactive computation from ledger timestamps — not designed here).
- Plan-approval gate before dispatch (new schema, new pre-dispatch phase, changes to `create_mission`/dispatch flow — its own future spec).
- Fetching GitHub's real `review_decision`/PR-approval state. Investigation (see below) confirmed Forge does not track this anywhere today — `auto-merge.ts` merges once CI passes without checking human PR approval. This spec does **not** add that integration; it only avoids mislabeling the absence of that data as if it existed.

## 1. Setup Page Stepper Header

`apps/web/src/app/(app)/setup/page.tsx` already tracks three states internally (no installation / installation, no repos / installation with repos). Add a horizontal 3-step header above the existing checklist content — Install → Select repos → Try it — with each step showing done (checkmark) / current / upcoming, driven by the same conditions the page already branches on. No new data, no schema changes.

## 2. Chat Suggested-Tasks Landing State

`apps/web/src/app/(app)/chat/chat-interface.tsx`'s empty-state block (the faded "FORGE" wordmark, `chat-interface.tsx:61-72`) is replaced with:
- 4 static suggestion chips: "Fix a failing test", "Triage open issues", "Bump a dependency, fleet-wide", "Add a feature". Clicking one fills the chat input with a starter prompt for that category — it does **not** auto-send; the user can edit before sending.
- A "Recent" list below the chips: the current user's 2 most recent missions (id, name, status pill), fetched via the same query shape the chat route's `list_missions` tool (`api/chat/route.ts`) already uses, scoped to `userId`, ordered by `createdAt desc`, limited to 2. This requires a new server-side fetch on page load (`chat/page.tsx` is currently a thin server component that only calls `withAuth()` and renders `<ChatInterface />` — add the query there and pass results as a prop).
- The wordmark/wallpaper large-logo treatment is removed entirely for the empty state (superseded by the above), but the chat's non-empty (has-messages) rendering path is unchanged.

## 3. Repo Workspace Identity Zone

`apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`'s current header (`repo` name + open-issue count + `RepoBudgetLine`, currently thin/inline) becomes a distinct, visually separated "identity zone" card above the three-column work area: repo name (mono, with the connected-to-GitHub indicator), open-issue count, spend/budget (reusing `RepoBudgetLine`), and a new "missions this month" count. The new count is `count(*) from missions where targetRepos contains this repo and createdAt >= start of current calendar month` — a new query function (e.g. `countMissionsThisMonth(userId, repo)` in `apps/web/src/lib/repo-activity.ts`, alongside the existing `listTasksTouchingRepo`). The "Files" button (already added in a prior change, opens the file-browser Sheet) moves into this zone, top-right.

## 4. Merge-State Stepper

Replaces the current flat `PrChip` badge (`components/pr-chip.tsx`, a single `"PR #{n} · {status}"` label) inside `IssueRunPanel` (`repos/[owner]/[repo]/issue-run-panel.tsx`) with a small horizontal 2-step stepper: **CI → Merge**.

- **CI step**: derived from the task's polled CI-check conclusions (`server/tick/ci.ts` aggregates GitHub check-run `conclusion` values into pass/fail already) — done (green check) once all required checks pass, in-progress (pulsing dot) while `awaiting_ci`, failed (red) if any check's conclusion is `failure`/`timed_out`.
- **Merge step**: done once task status is `merged`; in-progress while `merging`; upcoming otherwise.
- **Both steps** are **only shown once a PR exists** (`task.prUrl` is set) — before that, `IssueRunPanel` keeps its current stage-based rendering (reproduce/fix), unchanged.
- **`awaiting_review` is NOT part of this stepper.** It is surfaced as a separate small fixed-copy banner, "Needs human attention", shown above the stepper when the task is in that status — explicitly not implying GitHub PR review/approval, since Forge doesn't track that. The banner does not attempt to distinguish which of the four escalation paths (AI-review, verify, stall-sweep, auto-merge rollback) caused it; none of them currently persist a human-readable reason on the task row, and adding one is out of scope here.
- `PrChip` itself is not deleted — it's still used wherever a compact single-line PR reference is wanted (e.g. inside `IssueRunPanel`'s `prChips` row for past attempts); only the *primary* status display for the currently-viewed task's PR is replaced by the stepper.

## 5. Severity-Tiered Run Output

`workspace-list.tsx`'s "Run output" column (currently a single flat `SessionLogView` stream) gains a "Needs attention" tier above it: a short list of ledger events from the active task where `isErrorLogEvent()` (`lib/session-log-format.ts`) returns `true`, rendered expanded, each showing its formatted line (`formatLogLine()`) and a "Blocker" badge (reusing the existing critical-tone pill styling already used elsewhere, e.g. `mission-status-badge.tsx`'s tone conventions). Below it, the full `SessionLogView` stream is kept exactly as-is but wrapped in a collapsed-by-default disclosure labeled "Activity (`N` events)" — clicking expands it in place; state is local component state (`useState`), not persisted. If there are zero error events, the "Needs attention" tier is omitted entirely (no empty state needed — its absence is the signal).

## 6. Repos Page Rollup Strip + Table Reshape

`apps/web/src/app/(app)/repos/page.tsx` (already grouped-by-repo with sparklines from an earlier redesign this session) gains:
- A rollup strip above the existing table: **Repos connected** (count from `listUserRepos`), **Repos with a blocker** (count of distinct repos having ≥1 task currently in `awaiting_review` status), **Total spend this week** (reuses whatever spend aggregation `getDashboardStats`/`RepoBudgetLine` already compute, scoped to the user's repos).
- Table rows gain two new columns: **Missions** (count of missions touching that repo, reusing the same grouping the page already does via `groupMissionsByRepo`) and **Blockers** (count of that repo's tasks in `awaiting_review`, 0 shown plain, >0 shown in the warn-tone pill). The existing sparkline and status-tone columns are unchanged.
- "Blocker" is defined identically here and in the Repos page as: **a task currently in `awaiting_review` status** — the one real, already-existing proxy for "this needs a human," consistent with item 4's finding that Forge has no other/better signal for this today.

## Testing

- Items 1, 2 (suggestion chips), 3: no new business logic beyond simple queries — spot-check via existing "we don't unit-test page/rendering components" convention; the one new query each (missions-this-month count, recent-missions-for-chat) gets a real-DB-integration test following this session's established throwaway-libSQL-file pattern.
- Item 4 (merge-state stepper): the CI/Merge step-derivation logic (task status + CI conclusions → stepper state) is pure functions — unit-testable directly, following TDD, covering: no PR yet (stepper hidden), CI running, CI failed, CI passed, merging, merged, and the `awaiting_review` banner case.
- Item 5 (severity tiers): `isErrorLogEvent()` is already tested; the new grouping logic (partition a ledger array into attention/activity) is a small pure function, unit-testable.
- Item 6 (rollup strip + blockers): the "count of repos/tasks in `awaiting_review`" aggregation gets a real-DB-integration test.

## Explicitly Out of Scope (repeated for clarity)

- Fleet-progress burndown chart, plan-approval gate, and fetching GitHub's real PR review/approval state are all out of scope for this spec — see "Out of Scope" above.
