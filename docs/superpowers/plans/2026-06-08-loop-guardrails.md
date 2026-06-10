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
lastVerifiedSha: text('last_verified_sha'),
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

- [ ] **Step 1: Add the seven new vars**

Append to the `env` object:

```typescript
// Loop guardrails (see specs/2026-06-08-loop-guardrails-design.md).
TASK_MAX_TURNS: Number(process.env.TASK_MAX_TURNS ?? 30),
TASK_NO_PROGRESS_TOKENS: Number(process.env.TASK_NO_PROGRESS_TOKENS ?? 200_000),
TASK_MAX_TOKENS: Number(process.env.TASK_MAX_TOKENS ?? 0), // 0 = unbounded
BUDGET_HARD_STOP_PCT: Number(process.env.BUDGET_HARD_STOP_PCT ?? 100),
VERIFY_RETRY_MAX: Number(process.env.VERIFY_RETRY_MAX ?? 2),
VERIFY_MODEL: process.env.VERIFY_MODEL ?? 'claude-haiku-4-5', // checker ≠ maker
GATE_STALL_MS: Number(process.env.GATE_STALL_MS ?? 1_800_000), // 30 min gate stall sweep
```

- [ ] **Step 2: Typecheck.** `pnpm --filter tick typecheck`.

---

### Task 3: Turn + progress tracking in the state machine

**Files:** Modify `apps/tick/src/state.ts`, `apps/tick/src/poller.ts`
**Test:** `apps/tick/src/state.test.ts`

No `STATUS_RANK` is needed — progress is defined by a PR push, not by pipeline
position (see spec §1.1).

- [ ] **Step 1: Mark completed turns in `state.ts`**

Add one signal to the delta the poller consumes:

```typescript
export type StateTransition = {
  // …existing fields…
  /** True when this transition is a completed turn (running → turn_ended). */
  turnCompleted?: boolean;
};
```

Set `turnCompleted: true` on the `running → turn_ended` transition only.

- [ ] **Step 2: Count turns PER-EVENT in `poller.ts` (not per-delta)**

This is the critical correctness fix. `pollOne` folds all events into one merged
delta and calls `applyDelta` once; incrementing `turn_count` there would
**undercount** when a poll window contains several turns (the fast-spinning
runaway). Instead, accumulate in the event loop:

- In `pollOne`'s `for (const ev of events)` loop, keep a local
  `turnCompletedCount` and increment it whenever `transition()` returns a delta
  with `turnCompleted === true` **and** it's a distinct change (reuse the same
  guard the existing `transitionCount` uses at `poller.ts:116-119`).
- Pass that count into `applyDelta`, which sets `turn_count = task.turnCount + turnCompletedCount`.

- [ ] **Step 3: Stamp progress markers in `poller.ts`**

Progress = first PR push, and the no-progress clock starts at the first completed
turn (spec §1.1):

- On the **first** `turn_ended` for a Task (i.e. when `task.lastProgressAt` is
  null), set `last_progress_at = now` and `cost_tokens_at_progress = <costTokens
  after this poll's costTokensDelta>` — this starts the clock with headroom.
- When `delta.prUrl && !task.prUrl` (first PR attached), re-stamp both.
- No pipeline-rank logic; gate transitions are not progress.

Keep the existing single-tick-serial read-then-write assumption noted in
`applyDelta`.

- [ ] **Step 4: Tests**

In `state.test.ts` / poller tests: `turnCompleted` fires only into `turn_ended`;
a single poll containing two `idle→running→idle` cycles increments `turn_count`
by **2** (not 1); the first `turn_ended` stamps the progress baseline; a first PR
attach stamps progress; an `awaiting_ci → awaiting_verify` style hop is NOT
progress.

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

Select Tasks in **agent-active** statuses only —
`['dispatching','running','turn_ended','opening_pr']` — with a `sessionId`. Do
**not** scope to "all non-terminal": a Task parked at `awaiting_ci`/
`awaiting_verify`/`awaiting_review`/`merging` accrued its turns legitimately and
isn't burning agent tokens, so halting it there is a wrong-halt (spec §1).
Join each to its Mission and (if `mission.skillId`) its skill's `loopPolicy`.
For each breach:

1. `await getAdapter(mission.backend).cancelSession(task.sessionId).catch(...)` (best-effort, log on failure).
2. Guarded update → `status='failed', haltReason, lastError, completedAt=now WHERE id=? AND status=<observed>`.
3. Insert `task.halted` Ledger event `{ reason, turnCount, costTokens, costTokensAtProgress, limit }`.

Return `{ tasksChecked, halted, byReason }`.

- [ ] **Step 4: Tests** — precedence in `resolveLimits`; each breach reason at its
  boundary (off-by-one: `>=`); priority ordering when two limits breach at once;
  halted Task gets the right status + Ledger; `cancelSession` invoked; **and a
  `cancelSession` that throws does NOT block the `failed` transition** (cancel is
  best-effort).

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
  - For each `queued` Task: `status='abandoned', haltReason='budget_hard_stop', completedAt=now`
    (record *why* on the Task, not just the Mission event).
  - Guarded `missions` update → `status='cancelled', completedAt=now` **`WHERE
    id=? AND status=<observed>`** (the Mission may be `running` *or* `paused` —
    do NOT hard-code `status='running'` like the soft-pause guard, or paused-
    Mission hard-stops silently no-op). Accept the no-op on mismatch
    (`if (!updated) continue`), so an operator un-pausing mid-tick wins the race.
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
type to include `awaiting_verify`). The "which gate is next after this one
passes?" selection (`aiReviewEnabled ? awaiting_ai_review : awaiting_review`)
appears in both `ci.ts` and `verify.ts` (Task 8) — extract it into one small
shared helper so the two can't drift if a fourth gate is ever added.

- [ ] **Step 2: Tests** — green CI with self-verify on + criteria → `awaiting_verify`;
  self-verify on but no criteria → falls through to existing behavior; off →
  unchanged.

- [ ] **Step 3:** `pnpm --filter tick test --run ci` then `typecheck`.

---

### Task 8: Verify subsystem

**Files:** Create `apps/tick/src/verify.ts`, `apps/tick/src/verify.test.ts`
**Reference patterns:** near-clone the **reject→retry→escalate state machine** in
`ai-review.ts` (`reviewOne` — the validator `messages.create` + diff fetch +
counter + escalation + token attribution); `verify` differs only in prompt,
model, and counter. Also reuse `ci.ts`'s `buildRetryPrompt` shape for the
feedback turn. NOTE: `ai-review.ts` uses `claude-sonnet-4-6`; verify mirrors its
*control flow*, not its model (verify's default is the cheaper `VERIFY_MODEL`).

- [ ] **Step 1: Validator prompt + parse (pure, exported)**

`buildVerifyPrompt(acceptanceCriteria, diff)` and `parseVerdict(raw): { verdict: 'done' | 'incomplete'; missing?: string }`. Mirror `ai-review`'s JSON-extraction
robustness.

- [ ] **Step 2: Feedback prompt (pure, exported)**

`buildVerifyFeedback(missing)` — instructs the agent to address the missing
items on the same branch and push. Reuse the tone of `buildRetryPrompt`.

- [ ] **Step 3: `runVerify(log)`**

For each `awaiting_verify` Task:
- **Stale-diff / no-push guard via `lastVerifiedSha`:** re-fetch the PR head SHA.
  (a) If checks for that SHA aren't complete → skip this tick (wait). (b) If the
  SHA is **unchanged** since `task.lastVerifiedSha` (the agent pushed nothing in
  response to feedback) → **escalate to `awaiting_review`** with `verify.escalated`
  rather than re-grading the identical diff — this bounds the no-push case to zero
  extra validator calls and avoids depending on the unobservable "is a push in
  flight?" (a CI-less repo always reports `total_count === 0`). (c) Otherwise it's
  a genuinely new SHA → fetch the diff (Octokit, as `ai-review` does), read
  `acceptanceCriteria`, validate, and record `lastVerifiedSha = <head SHA>` in the
  same UPDATE as the verdict.
- Call the validator on a **checker ≠ maker** model: resolve
  `skill.loopPolicy?.verifyModel ?? env.VERIFY_MODEL` (default `claude-haiku-4-5`)
  and pass it as `model` to `messages.create`. **Fold the validator's token cost
  into the SAME status-transition UPDATE** (`costTokens = task.costTokens +
  used`), exactly as `ai-review` does — a separate UPDATE would clobber the
  read-then-write.
- `done` → set `awaiting_ai_review` if the Mission has AI review on, else
  `awaiting_review`; Ledger `verify.passed`.
- `incomplete` and `verifyRetryCount < env.VERIFY_RETRY_MAX` and `sessionId` →
  `adapter.sendTurn(sessionId, buildVerifyFeedback(missing))`, increment
  `verifyRetryCount`, set `awaiting_ci`; Ledger `verify.retry_dispatched`.
- `incomplete` exhausted → set `awaiting_review`; Ledger `verify.escalated`.

`VERIFY_RETRY_MAX` is the **only** bound on this loop — the §1 guardrail caps do
not apply at `awaiting_ci`/`awaiting_verify` (spec §3.2), so don't rely on them.

Return `{ tasksChecked, passed, retried, escalated, errors }`.

- [ ] **Step 4: Tests** — verdict parsing (`done`/`incomplete`/malformed→safe
  default); `done` routing with and without AI review; `incomplete` under cap
  sends a turn + resets to `awaiting_ci` + increments count; exhaustion escalates
  to `awaiting_review`; token cost attributed; validator model resolves
  `loopPolicy.verifyModel` over `env.VERIFY_MODEL`; **unchanged SHA → escalate
  with no second validator call; new SHA → re-validate; checks-incomplete → skip**.

- [ ] **Step 5: Reconciler gate stall sweep** (wedge backstop, spec §3.2/§9).

In `reconciler.ts`, add a sweep (alongside the existing `turn_ended`-no-PR
cleanup): any Task in a gate state (`awaiting_verify` / `awaiting_ai_review`) whose
`updatedAt` is older than `env.GATE_STALL_MS` is escalated to `awaiting_review`
with a `gate.stalled` Ledger event. This bounds a Task whose validator
persistently errors (it otherwise never advances and never increments
`verifyRetryCount`), so it can't hold a concurrency slot or block Mission
completion forever — the backstop when no budget is set. Add a
`reconciler.test.ts` case: a stale gate Task escalates, a fresh one is left alone.

- [ ] **Step 6:** `pnpm --filter tick test --run verify reconciler` then `typecheck`.

---

### Task 9: Wire verify into the tick (after ci, before aiReview)

**Files:** Modify `apps/tick/src/tick.ts`

- [ ] **Step 1:** Import `runVerify`; add to `TickResult`; call it after
  `runCiPoller` and before `runAiReview`, `.catch()`-wrapped with a zeroed
  result. **Insert into the real `tick.ts` order without reordering anything
  else** — current order is `poller → ci → aiReview → autoMerge → budgets →
  reconciler → dispatcher → memory`; `guardrails` goes after `poller`, `verify`
  after `ci`. Leave `dispatcher` before `memory` and `aiReview` before
  `autoMerge`. Update the doc comment.
- [ ] **Step 2:** `pnpm --filter tick typecheck`.

---

### Task 10: Dispatcher — resolve criteria/policy at dispatch

**Files:** Modify `apps/tick/src/dispatcher.ts`; tests in `dispatcher.test.ts`

- [ ] **Step 1: Add `awaiting_verify` to `INFLIGHT_STATUSES`** (8 → 9), in the
  right position. Note `dispatcher.test.ts` asserts the full `INFLIGHT_STATUSES`
  array with `toEqual` — update that literal too, not just a count.

- [ ] **Step 2: Resolve acceptance criteria at dispatch.**

Where the dispatcher already resolves the skill (`getSkill`), if the Task has no
`acceptanceCriteria` yet, copy `skill.loopPolicy?.acceptanceCriteria` onto it in
the same update that marks the Task dispatched.

- [ ] **Step 3: Do NOT stamp progress markers at dispatch.**

Leave `lastProgressAt` null and `costTokensAtProgress` at its default 0 — the
no-progress clock is started by the poller on the **first `turn_ended`** (Task 3
Step 3), giving the first turn headroom. Stamping `now` at dispatch would measure
the first turn against a 0 baseline and wrongly halt a legitimately large first
task (spec §1.1 / §9).

> **No isolation guard.** An earlier draft added a same-`(repo, baseBranch)`
> dispatcher guard. It's dropped (spec §9): each Task pushes to a unique
> `forge/<taskId>` work branch, so two Tasks sharing a base branch never collide,
> and the guard would only serialize sibling Tasks targeting `main` for no gain.

- [ ] **Step 4: Update the `INFLIGHT_STATUSES` `toEqual` literal** in
  `dispatcher.test.ts` to include `awaiting_verify` in the right position; the
  capacity-count test iterates the array, so it auto-adjusts.

- [ ] **Step 5:** `pnpm --filter tick test --run dispatcher` then `typecheck`.

---

### Task 11: Skill loader — frontmatter → loopPolicy

**Files:** Modify `apps/tick/src/skill-loader.ts`; tests in a new/updated
`skill-loader.test.ts`

- [ ] **Step 1: Parse YAML frontmatter with a real YAML parser.**

If `SKILL.md` starts with `---\n`, take the block up to the next `---` and parse
it with a proper YAML library (add `yaml` as a dep). Do **not** hand-roll: the
`acceptanceCriteria` field uses a multi-line block scalar (`|`), and a naive
parser would silently truncate it — a hard-to-notice failure that directly
weakens the verify gate. Strip the frontmatter from the `promptTemplate` body so
the agent prompt is unchanged. Tolerate a missing/empty `loopPolicy`.

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
  `.catch()` so one crash doesn't cascade. Insert into the existing order without
  reordering it: poller → **guardrails** → ci → **verify** → aiReview → autoMerge
  → budgets → reconciler → dispatcher → memory (dispatcher stays before memory).
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
