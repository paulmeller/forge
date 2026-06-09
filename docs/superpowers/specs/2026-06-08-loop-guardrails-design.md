# Loop Guardrails, Self-Verification & Skill-Carried Policy — Design Spec

**Date:** 2026-06-08
**Status:** Draft
**Scope:** Per-task hard stops (turn cap, no-progress detection, per-task token cap), a hard budget ceiling that cancels in-flight sessions, a `/goal`-style self-verification gate with a configurable checker model, and skills that carry their own loop policy.

---

## 0. Motivation

A *loop* is a specific architecture, not a vibe. The field has converged on five
building blocks plus a memory:

1. **Automations (the heartbeat).** A scheduled trigger that does discovery and
   triage on its own — the thing that turns "one run you did once" into a loop.
2. **Worktrees (isolation).** Parallel agents that can't step on each other's files.
3. **Skills.** Project knowledge written down once so the agent stops guessing it
   every session.
4. **Plugins / connectors (MCP).** The loop reaching into the tools you already
   use — issue tracker, CI, Slack.
5. **Sub-agents (maker ≠ checker).** One agent writes; a *different* one (often a
   different model) checks, so the loop's "it's done" means something.
6. **Memory.** Durable state outside any single conversation — the agent forgets
   between runs, the store doesn't.

Forge already implements all six, as the **fleet** version of what the
single-developer tools (Claude Code, Codex) do in one repo:

| Block | In Forge today |
|-------|----------------|
| Automations | Cloud Scheduler → `POST /tick` every 60s; the dispatcher claims queued Tasks; the LLM planner reads an issue tracker and emits Tasks (discovery/triage). |
| Worktrees | Each Task runs in its own MA/Gateway sandbox on its own branch (`forge/<taskId>`); `concurrencyCap` + atomic optimistic claim prevent double-claim. |
| Skills | `skills` table + `skill-loader.ts` + on-disk `SKILL.md` + `mission.skillId`. |
| Connectors | GitHub MCP (PR creation, vault-held creds, `AUTO_ALLOW_TOOLS`). |
| Sub-agents | Maker = the Task session; checker = the AI-review gate (a separate `messages.create`). |
| Memory | The **Ledger** (`ledger_events`), DB-backed Task/Mission state, and a confidence-scored `memories` table fed by retrospectives. |

That places Forge at the top of the lineage — `ReAct (2022) → AutoGPT (2023) →
ralph (2025) → /goal (2026) → multi-agent orchestration` — and the
Mission / Task / Gate machinery is the supervisor loop.

But *having* a block is not *having it well*. Three weaknesses sit exactly where
the building-block model and the production literature both point, and this spec
closes them:

1. **The loop's expensive failure mode is that it doesn't stop** (block #1, run
   unattended). AutoGPT's reputation came from spinning forever doing nothing;
   the 2026 write-ups converge on three hard stops — a maximum iteration count,
   no-progress detection, and a token/dollar ceiling. Forge today has only a
   *soft* budget pause (`runBudgets` flips a Mission to `paused` at 80%, but
   in-flight Tasks keep spending) and a CI-retry cap (`TASK_RETRY_MAX`). It has
   **no per-task turn cap, no no-progress detection, no hard ceiling that halts
   in-flight work, and no per-task token cap.** A single runaway session can burn
   unbounded tokens inside one Task without tripping anything. → §1, §2.

2. **A loop is only as good as its checker, and the checker should not be the
   maker** (block #5). Forge separates maker from checker *structurally* (the
   AI-review gate is a separate call), but it has no `/goal`-style *done-ness*
   validator that checks the work against an explicit definition of done and
   loops feedback — and it doesn't let the checker run a *different model* from
   the maker, which is the whole point of the split ("a strong model on high
   effort" grading a fast maker). → §3.

3. **The reusable unit is a skill, not a prompt** (block #3). Forge's skills
   carry only a prompt template + allowed tools — not the loop's bounds or its
   acceptance criteria, so every Mission re-specifies them (or, today, doesn't).
   → §4.

The other two blocks — broader **connectors** (#4: Linear/Slack beyond GitHub)
and worktree-grade **isolation guarantees** (#2: a hard guarantee that two Tasks
on the same repo can't share a branch) — are real but out of scope here; see §12.

This spec is deliberately additive: every new behavior is **off by default** and
gated behind a Mission flag or an env default, so existing Missions are
unaffected.

---

## 1. Loop Guardrails (hard stops)

A new tick subsystem `runGuardrails(log)` (`apps/tick/src/guardrails.ts`) that
runs immediately after the poller — so it sees the freshest `costTokens` and
`turnCount` the poller just wrote — and **before** `ci`, so a halted Task stops
accruing work as early as possible in the tick.

It enforces four per-task limits. For each non-terminal Task with a `sessionId`:

| Limit | Effective value | Breach condition | Halt reason |
|-------|-----------------|------------------|-------------|
| **Turn cap** | `mission.taskMaxTurns ?? skill.loopPolicy.maxTurns ?? env.TASK_MAX_TURNS` (30) | `task.turnCount >= maxTurns` | `max_turns` |
| **Per-task token cap** | `mission.taskMaxTokens ?? skill.loopPolicy.maxTokens ?? env.TASK_MAX_TOKENS` (0 = unbounded) | `cap > 0 && task.costTokens >= cap` | `task_token_cap` |
| **No-progress** | `mission.noProgressTokens ?? skill.loopPolicy.noProgressTokens ?? env.TASK_NO_PROGRESS_TOKENS` (200k) | `task.costTokens - task.costTokensAtProgress >= threshold` | `no_progress` |

(The mission-level hard **budget** ceiling is a separate, Mission-wide stop —
see §2 — because it has to cancel *every* in-flight Task at once, not one.)

**Halting a Task** means, atomically:

1. `adapter.cancelSession(task.sessionId)` — the adapter already exposes this
   (`managed-agents` sends `user.interrupt`). Best-effort; a failure to cancel
   is logged but does not block the status change.
2. `UPDATE tasks SET status='failed', haltReason=<reason>, lastError=<human
   string>, completedAt=now WHERE id=? AND status=<observed status>` (guarded
   update so a concurrent transition can't be clobbered).
3. Insert a `task.halted` Ledger event: `{ reason, turnCount, costTokens,
   costTokensAtProgress, limit }`.

Because the halted Task becomes `failed`, the existing reconciler cascade
(`DEPENDENCY_FAILED_STATUSES`) already fails its dependents and the existing
completion check already closes the Mission when everything settles. No new
terminal-state plumbing is needed.

### 1.1 Tracking `turnCount` and progress

These two counters are maintained by the poller's state machine, not by
guardrails — guardrails only reads them.

- **`turnCount`** increments by 1 each time a Task transitions **into**
  `turn_ended` (one completed agent turn = one `running → turn_ended` cycle).
  This is the iteration counter; it counts *every* turn, including auto-confirm
  resumes and verify/CI retry turns, which is exactly the "iteration count" the
  hard-stop literature means.

- **Progress** is a *forward* pipeline movement, not any status change. We add a
  `STATUS_RANK` ordering to `state.ts` (`queued=0 … merged=N`). A delta counts
  as progress when either (a) it raises the Task's status to a rank higher than
  any previously reached, or (b) it newly attaches a `prUrl`. On progress, the
  poller stamps `lastProgressAt = now` and `costTokensAtProgress = costTokens`.
  Crucially, the `running ↔ turn_ended` oscillation is **not** forward progress
  (same or lower rank), so a Task that keeps producing turns without advancing
  the pipeline will accumulate tokens against `costTokensAtProgress` and trip
  the no-progress limit — this is the AutoGPT guard.

`costTokensAtProgress` is initialized to 0 and `lastProgressAt` to dispatch
time when the Task is dispatched.

### 1.2 Why a dedicated subsystem (not folded into the reconciler)

The reconciler runs late in the tick and is about *settling* state (open
late PRs, complete Missions). Guardrails must run *early* and is about
*stopping* state. Keeping them separate matches the existing one-subsystem-
per-concern pattern and keeps each `.catch()`-wrapped block independently
debuggable in `tick.ts`.

---

## 2. Hard budget ceiling (Mission-wide stop)

Today `runBudgets` only does the soft pause: at `budgetThresholdPct` (default
80%) a *running* Mission flips to `paused`, but in-flight Tasks run to
completion and keep spending. A Mission paused at 80% can therefore drift to
150%+ as its in-flight Tasks finish — exactly the "billing surprises orders of
magnitude over budget" failure the production write-ups warn about.

We add a second, harder threshold: **`budgetHardStopPct`** (default 100%).

`runBudgets` is extended to evaluate **both `running` and `paused`** Missions
(a paused Mission can still cross the hard ceiling as in-flight Tasks land):

- `maxPct < budgetThresholdPct` → no action.
- `budgetThresholdPct <= maxPct < budgetHardStopPct` → soft pause (existing
  behavior, only for `running` Missions).
- `maxPct >= budgetHardStopPct` → **hard stop**:
  1. For every in-flight Task (status in `INFLIGHT_STATUSES`) with a
     `sessionId`: `adapter.cancelSession(...)`, then set `status='failed',
     haltReason='budget_hard_stop'`.
  2. For every `queued` Task: set `status='abandoned'`.
  3. Set Mission `status='cancelled'`.
  4. Ledger `budget.hard_stopped`: `{ spentTokens, spentUsd, budgetTokens,
     budgetUsd, hardStopPct, crossedAtPct }`.

The soft pause and the hard stop share one cost computation
(`computeBudgetPct`); only the action differs. `cancelled` is already a
terminal Mission state, so no lifecycle change is required — what changes is
that hard-stop *actively cancels* in-flight sessions rather than letting them
finish (the documented difference between Forge's existing `pause` and
`cancel`).

---

## 3. Self-verification gate (`/goal`-style done check)

A new optional gate, off unless `mission.selfVerifyEnabled` is true **and** the
Task has `acceptanceCriteria`. It answers a different question than the two
existing gates:

- **CI gate** (`ci.ts`): does the build/test pass? (objective, external)
- **AI review gate** (`ai-review.ts`): is this *good* code? (quality)
- **Self-verify gate** (new): is the task actually *done* against its stated
  acceptance criteria? (completeness — the `/goal` validator)

### 3.1 New status and pipeline position

Add `awaiting_verify` to the Task status enum, positioned between CI and the
review gates:

```
… → awaiting_ci → [awaiting_verify] → [awaiting_ai_review] → awaiting_review → merging → merged
```

`ci.ts` already chooses its green-CI target status (`awaiting_ai_review` if AI
review is on, else `awaiting_review`). That selection gains one branch: if
`selfVerifyEnabled && task.acceptanceCriteria`, green CI routes to
`awaiting_verify` first.

### 3.2 `runVerify(log)` (`apps/tick/src/verify.ts`)

For each `awaiting_verify` Task, call a cheap validator model
(`messages.create`, mirroring `ai-review.ts`'s structure and token attribution)
with: the Task's `acceptanceCriteria` and the PR diff (fetched via Octokit
exactly as `ai-review` does). The validator returns structured JSON
`{ verdict: 'done' | 'incomplete', missing?: string }`.

**The checker is not the maker** — that is the point of block #5. The validator
model resolves `skill.loopPolicy.verifyModel ?? env.VERIFY_MODEL` (default
`claude-haiku-4-5`), deliberately a *different* model from the agent that wrote
the code, so the loop's "it's done" is a second opinion rather than the maker
grading its own homework. A skill doing high-stakes work can name a stronger
checker (`verifyModel: claude-opus-4-8`); the env default keeps the common case
cheap. (The existing `ai-review` gate can adopt the same env knob later; this
spec only wires it for the verify gate.)

- **`done`** → advance to the next gate: `awaiting_ai_review` if AI review is
  enabled, else `awaiting_review`. Ledger `verify.passed`.
- **`incomplete`** and `verifyRetryCount < env.VERIFY_RETRY_MAX` (default 2) and
  a live `sessionId` → send a feedback turn to the same session
  (`adapter.sendTurn`) describing what's missing (reusing the CI
  retry-with-feedback shape), increment `verifyRetryCount`, and set the Task
  back to `awaiting_ci`. The agent pushes more commits, CI re-runs, and a green
  result routes back through `awaiting_verify` for re-checking. Ledger
  `verify.retry_dispatched`.
- **`incomplete`** with retries exhausted → **escalate**, don't fail: set
  `awaiting_review` (a human decides), Ledger `verify.escalated`. Failing
  silently would throw away possibly-good work; escalation matches how
  `ai-review` handles low-confidence verdicts.

The verify retry loop is bounded twice over: by `VERIFY_RETRY_MAX` directly,
and by the §1 turn cap / no-progress guard as a backstop (each retry turn
increments `turnCount` and, if it produces no forward progress, counts against
the no-progress budget). A verify loop physically cannot run away.

### 3.3 Acceptance criteria source

`tasks.acceptanceCriteria` (text, nullable) is resolved at **dispatch time**,
the same point where the dispatcher already resolves the skill, memories, and
AGENTS.md. Resolution order: the LLM planner may emit per-Task criteria
(written directly onto the Task at plan time); otherwise the dispatcher copies
`skill.loopPolicy.acceptanceCriteria` onto the Task. A Task with no criteria
from either source simply never enters `awaiting_verify` (CI green → existing
behavior), so the gate is inert exactly when it has nothing to check.

---

## 4. Skills carry loop policy (skills-as-first-class)

The reusable unit inside the loop is the skill. Today a skill is a prompt
template + allowed tools. We make the skill also the **carrier of the loop's
bounds and its definition of done**, so a Mission that picks `dependency-bump`
inherits sensible turn/token caps and acceptance criteria without re-specifying
them.

### 4.1 Schema

Add `skills.loopPolicy` (text JSON, nullable):

```ts
type LoopPolicy = {
  maxTurns?: number;
  maxTokens?: number;
  noProgressTokens?: number;
  selfVerify?: boolean;
  verifyModel?: string;
  acceptanceCriteria?: string;
};
```

### 4.2 Authored in SKILL.md frontmatter

`skill-loader.ts` is extended to parse optional YAML frontmatter at the top of
each `SKILL.md` and populate `loopPolicy` (and keep the existing
heading/description/tools parsing for the body). Example
`skills/dependency-bump/SKILL.md`:

```markdown
---
loopPolicy:
  maxTurns: 12
  noProgressTokens: 120000
  selfVerify: true
  acceptanceCriteria: |
    - Only the named dependency changed in package.json + lockfile.
    - No unrelated dependencies were bumped.
    - typecheck and the existing test suite pass.
    - A PR titled `chore(deps): bump <pkg> to <version>` is open.
---
# dependency-bump
…
```

This keeps the bounds and the done-definition versioned next to the playbook
they belong to — and it ties directly into the existing retrospective loop,
which already proposes `skill_diff` improvements: a retrospective can now also
tighten a skill's `loopPolicy` as evidence accumulates.

### 4.3 Precedence

Effective limits resolve **Mission override → skill policy → env default** (most
specific wins), so an operator can always tighten a single Mission without
editing the skill, and the env default is the floor for skill-less Missions.

---

## 5. Schema changes (migration 0008)

**`tasks`** — add:
- `turn_count` (integer, notNull, default 0)
- `last_progress_at` (integer timestamp_ms, nullable)
- `cost_tokens_at_progress` (integer, notNull, default 0)
- `verify_retry_count` (integer, notNull, default 0)
- `halt_reason` (text, nullable) — `max_turns | task_token_cap | no_progress | budget_hard_stop`
- `acceptance_criteria` (text, nullable)

**`missions`** — add:
- `budget_hard_stop_pct` (integer, notNull, default 100)
- `task_max_tokens` (integer, nullable)
- `task_max_turns` (integer, nullable)
- `no_progress_tokens` (integer, nullable)
- `self_verify_enabled` (integer/boolean, notNull, default false)

**`skills`** — add:
- `loop_policy` (text JSON, nullable)

**Status enum** — add `awaiting_verify` to `taskStatus` (code-level; SQLite text
columns don't enforce enums, so no SQL constraint).

---

## 6. New env (`apps/tick/src/env.ts`)

| Var | Default | Meaning |
|-----|---------|---------|
| `TASK_MAX_TURNS` | `30` | Per-task completed-turn cap |
| `TASK_NO_PROGRESS_TOKENS` | `200000` | Tokens spent without forward progress before halt |
| `TASK_MAX_TOKENS` | `0` | Per-task token ceiling (`0` = unbounded) |
| `BUDGET_HARD_STOP_PCT` | `100` | Mission-wide hard ceiling % (used when a Mission leaves it null) |
| `VERIFY_RETRY_MAX` | `2` | Self-verify feedback turns before escalation |
| `VERIFY_MODEL` | `claude-haiku-4-5` | Checker model for the verify gate (overridable per-skill via `loopPolicy.verifyModel`) |

`ANTHROPIC_API_KEY` already exists (used by `ai-review`); the verify validator
reuses it. No new credentials.

---

## 7. Tick ordering (`apps/tick/src/tick.ts`)

```
1. poller       (ingest events; maintain turnCount + progress markers)
2. guardrails   (NEW — halt tasks over turn/token/no-progress limits)
3. ci           (green CI → awaiting_verify | awaiting_ai_review | awaiting_review)
4. verify       (NEW — done-check; advance, retry, or escalate)
5. aiReview     (quality review)
6. autoMerge
7. budgets      (soft pause OR hard stop + cancel in-flight)
8. reconciler
9. memory
10. dispatcher  (resolve acceptanceCriteria + loopPolicy at dispatch)
```

Each step stays wrapped in its own `.catch()` returning a zeroed result, per the
existing convention.

---

## 8. New status registration checklist

`awaiting_verify` must be added to:
- `taskStatus` enum (`packages/db/src/schema.ts`)
- `INFLIGHT_STATUSES` (`dispatcher.ts`) — it holds a session and counts against concurrency
- `ALL_TASK_STATUSES` (`budgets.ts`)
- the task-status badge component (`apps/web`)
- `guardrails` scope (any non-terminal status with a session) — a Task can burn tokens during verify-retry turns

It must **not** be added to:
- `POLLABLE_STATUSES` (`poller.ts`) — the validator drives it, not backend events
- `MISSION_TERMINAL_TASK_STATUSES` (`reconciler.ts`) — it's mid-pipeline

---

## 9. Edge cases & interactions

- **Guardrails vs. an in-flight turn.** Cancelling a session that's mid-turn is
  best-effort; the poller may still ingest a trailing `session.status_idle`
  afterward. The guarded `status='failed'` update means those late events can't
  resurrect the Task — `state.ts` transitions are no-ops once a Task is
  terminal.
- **No-progress on a legitimately slow Task.** A large refactor that genuinely
  needs 300k tokens before its first PR will trip the default no-progress
  budget. That's why the limit is per-skill: skills for big-surface work raise
  `noProgressTokens`, and the Mission override is the escape hatch. The default
  is tuned for the common dependency-bump/codemod case.
- **Hard stop racing the dispatcher.** Budgets runs before the dispatcher in the
  tick, so within a single tick a hard-stopped Mission (now `cancelled`) is no
  longer a dispatch candidate (`status='running'` only). Cross-tick, the guarded
  updates prevent double action.
- **Self-verify + CI churn.** A verify `incomplete → awaiting_ci` with no new
  push leaves CI already green, so the next tick re-promotes to
  `awaiting_verify` and re-checks — burning one validator call and one
  `verifyRetryCount` per cycle. Bounded by `VERIFY_RETRY_MAX`; the §1 turn/no-
  progress guards are the hard backstop.
- **Budget attribution.** Verify and CI-retry validator/turn costs already flow
  into `task.costTokens` (same path as `ai-review`), so they count against both
  the per-task caps and the Mission budget automatically — no separate metering.
- **Same-repo isolation (block #2 invariant).** Two Tasks targeting the same repo
  already get distinct branches (`forge/<taskId>`) and run in separate sandboxes,
  so they don't collide. This spec only makes that an *explicit, tested
  invariant*: the dispatcher must never put two in-flight Tasks on the same
  `(repo, branch)` pair (a `verify`/CI-retry turn reuses the Task's own branch,
  which is fine — it's the same Task). Full worktree-grade isolation on a shared
  checkout is a separate workstream — see §12.

---

## 10. Testing strategy

- `guardrails.test.ts` — pure limit-resolution (Mission → skill → env
  precedence); each breach reason fires at the right boundary; halted Task gets
  `failed` + `halt_reason` + Ledger event; `cancelSession` is called.
- `verify.test.ts` — validator-JSON parsing; `done` routes correctly with/without
  AI review; `incomplete` under cap sends a turn and resets to `awaiting_ci`;
  exhaustion escalates to `awaiting_review`.
- `budgets.test.ts` — extend: hard-stop boundary; paused Missions are evaluated
  for the hard ceiling; in-flight cancelled + queued abandoned + Mission
  cancelled; soft pause still fires between thresholds.
- `state.test.ts` — `turnCount` increments only into `turn_ended`; `STATUS_RANK`
  progress detection; oscillation is not progress.
- `skill-loader.test.ts` — frontmatter parsing populates `loopPolicy`; a skill
  without frontmatter still loads (back-compat).
- Update the inflight-count assertions in `dispatcher.test.ts` (8 → 9 statuses).
- Pure functions extracted for each subsystem so tests avoid mocking the DB
  where possible (matches existing style).

---

## 11. File inventory

### New files
- `packages/db/migrations/0008_loop_guardrails.sql`
- `apps/tick/src/guardrails.ts`, `apps/tick/src/guardrails.test.ts`
- `apps/tick/src/verify.ts`, `apps/tick/src/verify.test.ts`

### Modified files
- `packages/db/src/schema.ts` — new status, Task/Mission/skills columns, `LoopPolicy` type
- `apps/tick/src/env.ts` — six new env vars (incl. `VERIFY_MODEL`)
- `apps/tick/src/tick.ts` — wire `guardrails` + `verify`
- `apps/tick/src/state.ts` — `STATUS_RANK`, `turnCount` increment, progress markers
- `apps/tick/src/poller.ts` — apply turnCount/progress deltas
- `apps/tick/src/ci.ts` — route green CI to `awaiting_verify` when enabled
- `apps/tick/src/budgets.ts` — hard-stop ceiling, evaluate paused Missions, `ALL_TASK_STATUSES += awaiting_verify`
- `apps/tick/src/verify.ts` — checker model resolves `loopPolicy.verifyModel ?? env.VERIFY_MODEL`
- `apps/tick/src/dispatcher.ts` — `INFLIGHT_STATUSES += awaiting_verify`; resolve `acceptanceCriteria` + `loopPolicy` at dispatch; init progress markers; same-`(repo, branch)` isolation guard
- `apps/tick/src/skill-loader.ts` — parse YAML frontmatter → `loopPolicy`
- `apps/web/src/components/task-status-badge.tsx` — `awaiting_verify` badge + `halt_reason` surfacing
- `apps/web/src/app/missions/new/new-mission-form.tsx` — `selfVerifyEnabled`, hard-stop %, per-task caps
- `skills/*/SKILL.md` — add `loopPolicy` frontmatter (acceptance criteria + bounds)
- `apps/tick/src/dispatcher.test.ts`, `budgets.test.ts`, `ci.test.ts` — assertion updates

---

## 12. Out of scope (follow-ups)

Operational follow-ups for the features in this spec:

- Operator notifications on halt/hard-stop (shares the deferred PRD §14 Q4
  webhook-notification work).
- A live Console widget for "tokens since last progress" / "turns used vs cap".
- Per-Mission *dollar*-denominated caps beyond the existing token→USD
  conversion in `computeBudgetPct`.

Building blocks this spec deliberately does **not** address — named here so they
stay tracked against the six-block model rather than getting lost:

- **Connector breadth (block #4).** Forge speaks GitHub MCP only. The "open the
  PR *and* update the Linear ticket *and* ping Slack when CI is green" loop needs
  more connectors wired through the existing MCP-vault seam. Separate spec.
- **Worktree-grade isolation (block #2).** §9 nails down the minimal
  same-`(repo, branch)` invariant; a true shared-history `git worktree` model
  (multiple Tasks against one checkout) is a larger execution-plane change.
- **Checker-model diversity for the AI-review gate (block #5).** This spec wires
  the configurable `verifyModel` only for the new verify gate; giving
  `ai-review` the same knob is a one-line follow-up.
- **Agent-invokable skill *registry* (block #3).** This spec makes skills *carry*
  policy; a skill *calling* other skills mid-loop is a different feature.
- **Automation/triage breadth (block #1).** The LLM planner is the discovery
  surface today; richer scheduled-triage recipes are product work, not loop
  guardrails.
