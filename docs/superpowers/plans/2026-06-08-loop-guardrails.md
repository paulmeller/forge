# Loop Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Forge's loops the three hard stops the production literature
demands (per-task turn cap, no-progress detection, token ceiling) plus a
Mission-wide hard budget ceiling that cancels in-flight sessions, a `/goal`-style
self-verification gate, and skills that carry their own loop policy.

**Design spec:** [`docs/superpowers/specs/2026-06-08-loop-guardrails-design.md`](../specs/2026-06-08-loop-guardrails-design.md)

**Architecture:** Two new tick subsystems (`guardrails`, `verify`) layered onto
the existing ordered tick loop, plus extensions to `budgets` (hard stop),
`state`/`poller` (turn + progress tracking), `ci` (route to the new gate), and
`skill-loader` (frontmatter → loop policy). One schema migration adds tracking
columns, config columns, a `loop_policy` skill column, and the
`awaiting_verify` status. Everything is off by default behind Mission flags and
env defaults.

**Tech Stack:** Drizzle/libSQL, Fastify tick service, Next.js web app, Anthropic
SDK (`messages.create`), Octokit, vitest.

**Precedence rule (applies throughout):** effective per-task limits resolve
**Mission override → skill `loopPolicy` → env default**.

---

### Task 1: Schema migration — new status, columns, loop policy

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0008_loop_guardrails.sql` (via `pnpm db:generate`)

- [ ] **Step 1: Add `awaiting_verify` to `taskStatus`**

In `packages/db/src/schema.ts`, insert `awaiting_verify` into the `taskStatus`
array, positioned between `awaiting_ci` and `awaiting_ai_review`:

```typescript
export const taskStatus = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
  'abandoned',
  'failed',
] as const;
```

- [ ] **Step 2: Add the `LoopPolicy` type and `haltReason` union**

Near the other exported types:

```typescript
export const haltReason = ['max_turns', 'task_token_cap', 'no_progress', 'budget_hard_stop'] as const;
export type HaltReason = (typeof haltReason)[number];

export type LoopPolicy = {
  maxTurns?: number;
  maxTokens?: number;
  noProgressTokens?: number;
  selfVerify?: boolean;
  verifyModel?: string;
  acceptanceCriteria?: string;
};
```

- [ ] **Step 3: Add Task tracking + verify columns**

On the `tasks` table:

```typescript
turnCount: integer('turn_count').notNull().default(0),
lastProgressAt: integer('last_progress_at', { mode: 'timestamp_ms' }),
costTokensAtProgress: integer('cost_tokens_at_progress').notNull().default(0),
verifyRetryCount: integer('verify_retry_count').notNull().default(0),
haltReason: text('halt_reason', { enum: haltReason }),
acceptanceCriteria: text('acceptance_criteria'),
```

- [ ] **Step 4: Add Mission config columns**

On the `missions` table:

```typescript
budgetHardStopPct: integer('budget_hard_stop_pct').notNull().default(100),
taskMaxTokens: integer('task_max_tokens'),
taskMaxTurns: integer('task_max_turns'),
noProgressTokens: integer('no_progress_tokens'),
selfVerifyEnabled: integer('self_verify_enabled', { mode: 'boolean' }).notNull().default(false),
```

- [ ] **Step 5: Add `loopPolicy` to `skills`**

```typescript
loopPolicy: text('loop_policy', { mode: 'json' }).$type<LoopPolicy>(),
```

- [ ] **Step 6: Generate the migration**

Run: `cd packages/db && pnpm db:generate`
Confirm `migrations/0008_*.sql` adds all columns and that no destructive
statements appear (SQLite ALTER ADD COLUMN only).

- [ ] **Step 7: Typecheck the db package**

Run: `pnpm --filter db typecheck` — must pass.

---

### Task 2: Env config

**Files:** Modify `apps/tick/src/env.ts`

- [ ] **Step 1: Add the six new vars**

Append to the `env` object:

```typescript
// Loop guardrails (see specs/2026-06-08-loop-guardrails-design.md).
TASK_MAX_TURNS: Number(process.env.TASK_MAX_TURNS ?? 30),
TASK_NO_PROGRESS_TOKENS: Number(process.env.TASK_NO_PROGRESS_TOKENS ?? 200_000),
TASK_MAX_TOKENS: Number(process.env.TASK_MAX_TOKENS ?? 0), // 0 = unbounded
BUDGET_HARD_STOP_PCT: Number(process.env.BUDGET_HARD_STOP_PCT ?? 100),
VERIFY_RETRY_MAX: Number(process.env.VERIFY_RETRY_MAX ?? 2),
VERIFY_MODEL: process.env.VERIFY_MODEL ?? 'claude-haiku-4-5', // checker ≠ maker
```

- [ ] **Step 2: Typecheck.** `pnpm --filter tick typecheck`.

---

### Task 3: Turn + progress tracking in the state machine

**Files:** Modify `apps/tick/src/state.ts`, `apps/tick/src/poller.ts`
**Test:** `apps/tick/src/state.test.ts`

- [ ] **Step 1: Add `STATUS_RANK` to `state.ts`**

A pipeline ordering used to detect *forward* progress. Terminal failure states
sort low so they never count as progress:

```typescript
export const STATUS_RANK: Record<TaskStatus, number> = {
  queued: 0,
  dispatching: 1,
  running: 2,
  turn_ended: 2,        // same rank as running — oscillation is NOT progress
  opening_pr: 3,
  awaiting_ci: 4,
  awaiting_verify: 5,
  awaiting_ai_review: 6,
  awaiting_review: 7,
  merging: 8,
  merged: 9,
  abandoned: 0,
  failed: 0,
};
```

- [ ] **Step 2: Extend `StateTransition` with progress signals**

Add two computed flags to the delta the poller consumes:

```typescript
export type StateTransition = {
  // …existing fields…
  /** True when this transition is a completed turn (→ turn_ended). */
  turnCompleted?: boolean;
  /** True when this transition is forward progress (new max rank or PR attached). */
  forwardProgress?: boolean;
};
```

Set `turnCompleted: true` on the `running → turn_ended` transition. Leave
`forwardProgress` for the poller to compute (it knows the prior status + prUrl).

- [ ] **Step 3: Compute progress + apply counters in `poller.ts`**

In `applyDelta` (or where the merged delta is applied), after determining the
new status:

- If `delta.turnCompleted`, set `turn_count = task.turnCount + 1`.
- Compute `forwardProgress = (STATUS_RANK[newStatus] > STATUS_RANK[task.status]) || (delta.prUrl && !task.prUrl)`.
- If `forwardProgress`, set `last_progress_at = now` and
  `cost_tokens_at_progress = <costTokens after this delta's costTokensDelta>`.

Keep the existing single-tick-serial read-then-write assumption noted in
`applyDelta`.

- [ ] **Step 4: Tests**

In `state.test.ts`: `turnCompleted` fires only into `turn_ended`;
`running ↔ turn_ended` is not forward progress; `awaiting_ci` from `turn_ended`
is forward progress; PR attach is progress.

- [ ] **Step 5:** `pnpm --filter tick test --run state` then `typecheck`.

---

### Task 4: Guardrails subsystem

**Files:** Create `apps/tick/src/guardrails.ts`, `apps/tick/src/guardrails.test.ts`
**Reference pattern:** `apps/tick/src/budgets.ts` (query running work, act, Ledger).

- [ ] **Step 1: Limit resolution helper (pure, exported)**

```typescript
export function resolveLimits(opts: {
  mission: { taskMaxTurns: number | null; taskMaxTokens: number | null; noProgressTokens: number | null };
  policy: LoopPolicy | null;
  env: { TASK_MAX_TURNS: number; TASK_MAX_TOKENS: number; TASK_NO_PROGRESS_TOKENS: number };
}): { maxTurns: number; maxTokens: number; noProgressTokens: number }
```

Precedence: Mission override → `policy` → env. `maxTokens` of 0 means unbounded.

- [ ] **Step 2: Breach check helper (pure, exported)**

```typescript
export function checkBreach(task, limits): HaltReason | null
```

Priority order: `max_turns` → `task_token_cap` → `no_progress`. No-progress uses
`task.costTokens - task.costTokensAtProgress >= limits.noProgressTokens`.

- [ ] **Step 3: `runGuardrails(log)`**

Select non-terminal Tasks with a `sessionId` (statuses in `INFLIGHT_STATUSES`
minus pure-gate states is fine, but simplest: all non-terminal with a session).
Join each to its Mission and (if `mission.skillId`) its skill's `loopPolicy`.
For each breach:

1. `await getAdapter(mission.backend).cancelSession(task.sessionId).catch(...)` (best-effort, log on failure).
2. Guarded update → `status='failed', haltReason, lastError, completedAt=now WHERE id=? AND status=<observed>`.
3. Insert `task.halted` Ledger event `{ reason, turnCount, costTokens, costTokensAtProgress, limit }`.

Return `{ tasksChecked, halted, byReason }`.

- [ ] **Step 4: Tests** — precedence in `resolveLimits`; each breach reason at its
  boundary (off-by-one: `>=`); priority ordering when two limits breach at once;
  halted Task gets the right status + Ledger; `cancelSession` invoked.

- [ ] **Step 5:** `pnpm --filter tick test --run guardrails` then `typecheck`.

---

### Task 5: Wire guardrails into the tick (after poller, before ci)

**Files:** Modify `apps/tick/src/tick.ts`

- [ ] **Step 1:** Import `runGuardrails`; add to `TickResult`.
- [ ] **Step 2:** Call it after `runPoller` and before `runCiPoller`, wrapped in
  `.catch()` returning `{ tasksChecked: 0, halted: 0, byReason: {} }`. Update
  the ordered-steps doc comment.
- [ ] **Step 3:** `pnpm --filter tick typecheck`.

---

### Task 6: Hard budget ceiling in `budgets.ts`

**Files:** Modify `apps/tick/src/budgets.ts`; tests in `budgets.test.ts`

- [ ] **Step 1: Add `awaiting_verify` to `ALL_TASK_STATUSES`.**

- [ ] **Step 2: Evaluate paused Missions too.**

Change the candidate query from `eq(status,'running')` to
`inArray(status, ['running','paused'])`.

- [ ] **Step 3: Branch on the two thresholds.**

After `computeBudgetPct`:

- `maxPct >= mission.budgetHardStopPct` → **hard stop** (new helper
  `hardStop(mission, spentTokens, spentUsd, maxPct)`):
  - For each in-flight Task (`INFLIGHT_STATUSES`) with `sessionId`:
    `adapter.cancelSession`, then `status='failed', haltReason='budget_hard_stop', completedAt=now`.
  - For each `queued` Task: `status='abandoned', completedAt=now`.
  - Guarded `missions` update → `status='cancelled', completedAt=now`.
  - Ledger `budget.hard_stopped`.
- else `maxPct >= mission.budgetThresholdPct && mission.status==='running'` →
  existing soft pause (unchanged).

- [ ] **Step 4: Tests** — hard-stop boundary (`>=`); a *paused* Mission crossing
  the hard ceiling is cancelled and its in-flight Tasks cancelled + failed;
  queued abandoned; soft pause still fires strictly between the thresholds;
  `cancelSession` called per in-flight Task.

- [ ] **Step 5:** `pnpm --filter tick test --run budgets` then `typecheck`.

---

### Task 7: Route green CI to the verify gate

**Files:** Modify `apps/tick/src/ci.ts`; tests in `ci.test.ts`

- [ ] **Step 1: Extend the green-CI target selection.**

In `checkOne`, the mission lookup already fetches `aiReviewEnabled`; also fetch
`selfVerifyEnabled`. Compute `nextReviewStatus`:

```
if (selfVerifyEnabled && task.acceptanceCriteria) -> 'awaiting_verify'
else if (aiReviewEnabled)                          -> 'awaiting_ai_review'
else                                               -> 'awaiting_review'
```

Pass it through the existing `transitionToReview(...)` calls (widen its param
type to include `awaiting_verify`).

- [ ] **Step 2: Tests** — green CI with self-verify on + criteria → `awaiting_verify`;
  self-verify on but no criteria → falls through to existing behavior; off →
  unchanged.

- [ ] **Step 3:** `pnpm --filter tick test --run ci` then `typecheck`.

---

### Task 8: Verify subsystem

**Files:** Create `apps/tick/src/verify.ts`, `apps/tick/src/verify.test.ts`
**Reference patterns:** `ai-review.ts` (validator `messages.create` + diff fetch + token attribution) and `ci.ts` (`buildRetryPrompt` + retry-with-feedback).

- [ ] **Step 1: Validator prompt + parse (pure, exported)**

`buildVerifyPrompt(acceptanceCriteria, diff)` and `parseVerdict(raw): { verdict: 'done' | 'incomplete'; missing?: string }`. Mirror `ai-review`'s JSON-extraction
robustness.

- [ ] **Step 2: Feedback prompt (pure, exported)**

`buildVerifyFeedback(missing)` — instructs the agent to address the missing
items on the same branch and push. Reuse the tone of `buildRetryPrompt`.

- [ ] **Step 3: `runVerify(log)`**

For each `awaiting_verify` Task:
- Fetch the PR diff (Octokit, as `ai-review` does) and read `acceptanceCriteria`.
- Call the validator on a **checker ≠ maker** model: resolve
  `skill.loopPolicy?.verifyModel ?? env.VERIFY_MODEL` (default `claude-haiku-4-5`)
  and pass it as the `model` to `messages.create`; attribute its token cost to
  `task.costTokens` (same path as `ai-review`).
- `done` → set `awaiting_ai_review` if the Mission has AI review on, else
  `awaiting_review`; Ledger `verify.passed`.
- `incomplete` and `verifyRetryCount < env.VERIFY_RETRY_MAX` and `sessionId` →
  `adapter.sendTurn(sessionId, buildVerifyFeedback(missing))`, increment
  `verifyRetryCount`, set `awaiting_ci`; Ledger `verify.retry_dispatched`.
- `incomplete` exhausted → set `awaiting_review`; Ledger `verify.escalated`.

Return `{ tasksChecked, passed, retried, escalated, errors }`.

- [ ] **Step 4: Tests** — verdict parsing (`done`/`incomplete`/malformed→safe
  default); `done` routing with and without AI review; `incomplete` under cap
  sends a turn + resets to `awaiting_ci` + increments count; exhaustion escalates
  to `awaiting_review`; token cost attributed; validator model resolves
  `loopPolicy.verifyModel` over `env.VERIFY_MODEL`.

- [ ] **Step 5:** `pnpm --filter tick test --run verify` then `typecheck`.

---

### Task 9: Wire verify into the tick (after ci, before aiReview)

**Files:** Modify `apps/tick/src/tick.ts`

- [ ] **Step 1:** Import `runVerify`; add to `TickResult`; call it after
  `runCiPoller` and before `runAiReview`, `.catch()`-wrapped with a zeroed
  result. Update the doc comment.
- [ ] **Step 2:** `pnpm --filter tick typecheck`.

---

### Task 10: Dispatcher — resolve criteria/policy + init progress markers

**Files:** Modify `apps/tick/src/dispatcher.ts`; tests in `dispatcher.test.ts`

- [ ] **Step 1: Add `awaiting_verify` to `INFLIGHT_STATUSES`** (8 → 9).

- [ ] **Step 2: Resolve acceptance criteria at dispatch.**

Where the dispatcher already resolves the skill (`getSkill`), if the Task has no
`acceptanceCriteria` yet, copy `skill.loopPolicy?.acceptanceCriteria` onto it in
the same update that marks the Task dispatched.

- [ ] **Step 3: Initialize progress markers on dispatch.**

In the update that sets `status='running'`/`dispatchedAt`, also set
`lastProgressAt = now` and leave `costTokensAtProgress` at its default 0.

- [ ] **Step 4: Enforce the same-`(repo, branch)` isolation invariant** (block #2,
  spec §9). When claiming `queued` Tasks, skip any Task whose `(repo, baseBranch)`
  pair already has an in-flight Task (status in `INFLIGHT_STATUSES`) on the same
  Mission — leave it `queued` for a later tick. Each Task already gets a unique
  `forge/<taskId>` work branch, so this only guards the base-branch claim; it does
  not change branch naming.

- [ ] **Step 5: Update the inflight-count assertion** in `dispatcher.test.ts`
  (the existing test that asserts the number of inflight statuses) to 9; add a
  test that two same-`(repo, branch)` Tasks don't both go in-flight in one tick.

- [ ] **Step 6:** `pnpm --filter tick test --run dispatcher` then `typecheck`.

---

### Task 11: Skill loader — frontmatter → loopPolicy

**Files:** Modify `apps/tick/src/skill-loader.ts`; tests in a new/updated
`skill-loader.test.ts`

- [ ] **Step 1: Parse YAML frontmatter.**

Add a small frontmatter splitter: if `SKILL.md` starts with `---\n`, take the
block up to the next `---`, parse it as YAML (use an existing dep if present;
otherwise a minimal hand-parser limited to the `loopPolicy` shape is acceptable
— keep it dependency-light and tolerant of missing keys). Strip the frontmatter
from the `promptTemplate` body so the agent prompt is unchanged.

- [ ] **Step 2: Populate `loopPolicy`.**

Extend `SkillDefinition` with `loopPolicy: LoopPolicy | null`; thread it through
`loadSkillsFromDisk` and into `syncSkillsToDb` (insert + the change-detection
update — include `loopPolicy` in the diff so policy edits re-sync).

- [ ] **Step 3: Tests** — frontmatter parsed into `loopPolicy`; body stripped of
  frontmatter; a skill with no frontmatter still loads with `loopPolicy: null`
  (back-compat).

- [ ] **Step 4:** `pnpm --filter tick test --run skill-loader` then `typecheck`.

---

### Task 12: Author loop policy into the built-in skills

**Files:** Modify `skills/*/SKILL.md`

- [ ] **Step 1:** Add a `loopPolicy` frontmatter block to each built-in skill
  (`dependency-bump`, `codemod-rollout`, `ci-fix`, `forge-dev`) with sensible
  per-skill `maxTurns`, `noProgressTokens`, `selfVerify`, and `acceptanceCriteria`
  drawn from each skill's existing Constraints/Instructions. Keep the body
  (heading + instructions) unchanged below the frontmatter.

- [ ] **Step 2:** Re-run the loader test to confirm all built-ins parse.

---

### Task 13: Web — status badge + Mission form

**Files:** Modify `apps/web/src/components/task-status-badge.tsx`,
`apps/web/src/app/missions/new/new-mission-form.tsx`

- [ ] **Step 1:** Add an `awaiting_verify` case (label + color) to the status
  badge; surface `haltReason` on `failed` Tasks (e.g. a tooltip/subtext).
- [ ] **Step 2:** Add Mission-creation controls: `selfVerifyEnabled` toggle,
  `budgetHardStopPct` (default 100), and optional per-task `taskMaxTurns` /
  `taskMaxTokens` / `noProgressTokens`. Wire them through the create-Mission
  API payload (mirror how `aiReviewEnabled` is wired).
- [ ] **Step 3:** `pnpm --filter web typecheck && pnpm --filter web test`.

---

### Task 14: Final verification

- [ ] **Step 1: Full typecheck.**
  `pnpm --filter db typecheck && pnpm --filter tick typecheck && pnpm --filter web typecheck` — all clean.
- [ ] **Step 2: Full test suite.**
  `pnpm --filter tick test && pnpm --filter web test` — all pass.
- [ ] **Step 3:** Commit any fixups.

---

## Testing

- Run: `pnpm --filter tick test` and `pnpm --filter web test`.
- Typecheck: `pnpm --filter <pkg> typecheck`.
- Extract pure functions (`resolveLimits`, `checkBreach`, `parseVerdict`,
  `buildVerify*`) for testability rather than mocking the DB.
- Test files live next to source: `foo.ts` → `foo.test.ts`.

## Key patterns

- **Tick loop** (`apps/tick/src/tick.ts`): ordered subsystems, each wrapped in
  `.catch()` so one crash doesn't cascade. New order: poller → **guardrails** →
  ci → **verify** → aiReview → autoMerge → budgets → reconciler → memory →
  dispatcher.
- **Ledger events**: every state change inserts a `ledgerEvents` row — the audit
  trail. New events: `task.halted`, `budget.hard_stopped`, `verify.passed`,
  `verify.retry_dispatched`, `verify.escalated`.
- **Adapter pattern** (`apps/tick/src/adapters/`): hard stops use the existing
  `cancelSession`; the verify validator reuses `messages.create` + `ANTHROPIC_API_KEY`.
- **Status-driven queries**: adding `awaiting_verify` means updating
  `INFLIGHT_STATUSES` (dispatcher), `ALL_TASK_STATUSES` (budgets), and the
  task-status-badge — but NOT `POLLABLE_STATUSES` or `MISSION_TERMINAL_TASK_STATUSES`.
- **Limit precedence**: Mission override → skill `loopPolicy` → env default,
  everywhere limits are resolved.
