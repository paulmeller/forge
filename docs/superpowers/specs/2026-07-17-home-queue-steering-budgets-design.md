# Home Work Queue, Steering, and Budget Visibility — Design

Date: 2026-07-17
Status: approved (brainstorm complete)
Scope: three UI/product gaps identified by competitor research (Devin, OpenAI
Codex, Google Jules, GitHub Agent HQ, Cursor, Conductor, Vibe Kanban,
OpenHands, Terragon, Linear-native agents)

## Context

Competitor research converged on a small set of table-stakes patterns for
issue→PR agent products, three of which Forge lacks:

1. **"Needs human" as the organizing signal.** Every competitor centers a
   queue you clear (Codex "Needs input", Devin "Awaiting instructions",
   Vibe Kanban's auto-transition into an "In Review" column). Forge's
   `/home` is currently a flat missions table.
2. **Mid-run steering.** Every competitor lets you message a running agent;
   Forge only has Abort. The Managed Agents API supports this today — the
   adapter already sends `user.message` events, and the API-audit spike
   verified mid-turn appends are accepted.
3. **Cost visibility.** No competitor displays per-task/per-repo cost well.
   Forge has real budgets and a spend ledger — its differentiator — but the
   UI barely surfaces them.

Deferred to later cycles (explicitly out of scope here): in-product diff
tab, GitHub status comments, plan-approval gate, best-of-N attempts.

## 1. Home work queue (`/home`)

The missions table returns to living only on `/missions`. `/home` becomes a
task-level work queue with three sections, top to bottom:

- **Needs you** — tasks in `awaiting_review` (PR chip shown when `prUrl`
  set), `failed`, or halted (`haltReason` set). Sorted by `updatedAt`
  descending. This is the page's reason to exist: the inbox you clear.
- **Working** — in-flight tasks (`queued`, `dispatching`, `running`,
  `opening_pr`, `awaiting_ci`, `awaiting_verify`, `awaiting_ai_review`,
  `merging`), each with the pulsing live dot and the `TaskProgressPill`
  (tool count · elapsed · tokens). The existing `LiveRefresh` poller (5s)
  renders in the page header whenever this section is non-empty.
- **Recently done** — last 10 terminal outcomes (`merged`, `resolved`,
  `abandoned`) with outcome badge.

Row anatomy (all sections): issue ref or mission name, repo (mono), status
badge, cost chip (`tokensToUsd(task.costTokens)`, hidden when zero),
relative updated time. Whole row is clickable:

- Issue tasks (`task.issueRef` set) → `/repos/{repo}?issue={number}` via
  the existing `parseIssueRef`, landing on the repo console with that
  issue pre-selected.
- Campaign tasks → `/missions/{missionId}/tasks/{taskId}`.

The metric-card row (PRs merged / active agents / total spend / connected
repos) stays on top, as does the connect-repos banner. A "View all
missions →" link points at `/missions`.

Data: `getNeedsYou` exists; `getNowRunning` and `getRecentOutcomes` are
restored from git history into `lib/home.ts` (they were removed when the
rail was dropped). No schema changes.

## 2. Steering input

A shared client component `SteerInput` (single-line input + Send button,
disabled while pending, inline error on failure — same idiom as the Abort
button) rendered in two places:

- `IssueRunPanel`, directly under the live console box.
- The task detail page (`/missions/[missionId]/tasks/[taskId]`), under its
  session log view.

Visibility rule: only when the selected task has a `sessionId` and its
status is in `['dispatching', 'running', 'turn_ended', 'opening_pr']` —
the same set as the Abort button, for consistency.

Server action `steerTask(taskId: string, message: string)` in the repo
workspace `actions.ts`, mirroring `abortTask`'s hardened pattern exactly:

1. `const user = await withAuth()` — never discard the user.
2. Look up the task via `innerJoin(missions)` and reject with generic
   `'Task not found'` unless `missions.userId === user.id` (IDOR guard).
3. Reject empty/whitespace-only messages; trim before sending.
4. Guard: reject if no `sessionId` or status in `TERMINAL_TASK_STATUSES`.
5. Send the message into the running session via a local helper (same
   shape as `cancelManagedAgentsSession`):
   `client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }] })`
   — matching the adapter's existing `user.message` construction in
   `apps/tick/src/adapters/managed-agents.ts`.
6. On success, insert a ledger event: `eventType: 'task.steered'`, payload
   `{ sessionId, message }` — steering becomes part of the audit trail. A
   single insert; no task-row mutation, so no transaction needed.
7. Return `{ ok: true } | { ok: false; error: string }`.

The steered message subsequently appears in the live console via the
session event stream (it is a session event like any other). No optimistic
echo in v1.

## 3. Budgets front-and-center

- **Repo console** (`/repos/[owner]/[repo]`): a compact budget line under
  the repo title, next to the LiveRefresh indicator: `Spent $X · cap $Y`
  with a thin progress bar, or `Spent $X · no cap` (no bar) when the
  container has no `budgetUsd`. Data: a pure helper
  `computeRepoBudget(missions)` summing `spentUsd` across the user's
  missions for that repo (containers hold no spend; leaves accrue it —
  summing all is safe) with the cap read from the container's `budgetUsd`.
  Returns `{ spentUsd, capUsd, pct }` (`capUsd`/`pct` null when uncapped).
- **Home**: the per-row cost chips described above; the Total spend metric
  card already exists.
- Rendering reuses the visual language of the existing `BudgetGauge`
  (mission detail) at compact scale; no new design tokens.

## Error handling

- `steerTask` failures (network, dead session, ownership, empty message)
  surface as inline red text under the input, message preserved so the
  user can retry.
- Queue queries are server-rendered; failures fall back to the page-level
  error boundary as today.

## Testing

- `computeRepoBudget` and any queue-shaping pure helpers: unit tests
  (including the no-cap, zero-spend, and container+leaf-mix cases).
- `steerTask`: no dedicated test file, matching the repo-wide convention
  for server actions with live network calls (`abortTask`, `workOnIssue`);
  its guard order mirrors `abortTask`, which the final review re-verifies.
- Whole-repo `pnpm typecheck` and full web/tick suites stay green.
- Live browser walkthrough: dispatch a sandbox issue, steer the running
  task, verify the message reaches the session (console shows it) and the
  `task.steered` ledger event lands; verify queue sections and budget bar
  against real data.
