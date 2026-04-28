# Autonomous Software Building — Design Spec

**Date:** 2026-04-26
**Status:** Approved
**Scope:** LLM Planner, AI Review Gate, AGENTS.md Injection

---

## 1. LLM Planner

### Overview

Replace the rule-based planner (`one task per repo, identical prompts`) with an LLM-powered decomposition that produces a DAG of tasks with specific sub-goal prompts and dependency ordering.

### Schema changes

- **tasks.dependsOn** (`text`, nullable) → **tasks.dependsOnIds** (`text JSON`, nullable, `string[]`). Supports diamond DAGs where a task depends on multiple upstream tasks.
- No new tables. `plannerStrategy: 'llm'` already exists in the enum.

### Planner flow

1. Operator creates mission (draft) with `plannerStrategy: 'llm'`.
2. Operator clicks "Plan Mission" → POST `/api/missions/{id}/plan`.
3. Web app calls Claude `messages.create` **outside** the DB transaction:
   - System prompt: structured instructions to decompose the goal
   - User prompt: mission goal + target repos + any skill template
   - Response format: JSON with tasks array
4. Parse and validate the response:
   - Each task has: `repo`, `label`, `prompt`, `dependsOnIndices` (array of integer indices)
   - **Validate acyclicity** via DFS on the index graph. Reject if cyclic.
   - Validate all repos are in `targetRepos`.
5. Open DB transaction, insert tasks, resolve index-based dependencies to real task IDs.
6. Transition mission `draft → planning`.
7. Operator reviews tasks in plan preview UI, then starts.

### Planner prompt

```
You are decomposing a software engineering goal into discrete tasks.

Goal: {mission.goal}
Target repositories: {mission.targetRepos}
{skill template if attached}

Return JSON:
{
  "reasoning": "brief explanation of your decomposition strategy",
  "tasks": [
    {
      "repo": "owner/repo",
      "label": "short human-readable label",
      "prompt": "specific instructions for this task's agent session",
      "dependsOnIndices": []
    }
  ]
}

Rules:
- Each task targets exactly one repo.
- A task's prompt should be self-contained — the agent won't see other tasks.
- Use dependsOnIndices to express ordering (0-indexed into this array).
- Prefer independent tasks when possible. Only add dependencies when the output of one task is genuinely required by another.
- Do NOT create more than 20 tasks.
```

### DAG execution in dispatcher

In `claimNextBatch`, add a filter: skip queued tasks where any ID in `dependsOnIds` points to a task NOT in a terminal-success state.

**Terminal-success states for dependency resolution: `merged` only.** A task must be merged (code in the branch) before its dependents can start. `awaiting_review` is not sufficient — the code isn't committed yet.

### Dependency failure cascade (reconciler)

New phase in `runReconciler`, before the existing stall check:

```
For each queued task with non-empty dependsOnIds:
  If any dependency has status 'failed' or 'abandoned':
    Transition task → failed
    Set lastError: "upstream dependency {dep_id} {dep_status}"
    Insert ledger event: task.dependency_failed
```

This runs every tick. Cascades propagate naturally: if A fails, B (depends on A) fails next tick, C (depends on B) fails the tick after.

### Cycle validation

At plan time, build adjacency list from `dependsOnIndices`. Run iterative DFS with a "visiting" set. If any node is visited while already in the visiting set, reject the plan with an error message.

---

## 2. AI Review Gate

### Overview

After CI passes, optionally spawn an AI code review that checks the PR diff against the original mission goal before allowing auto-merge. Uses a direct Claude API call (not an MA session).

### Schema changes

- Add `'awaiting_ai_review'` to `taskStatus` enum (between `awaiting_ci` and `awaiting_review`).
- Add `aiReviewEnabled` (`integer`, boolean mode, default false) to `missions` table.
- Add `aiReviewRetryCount` (`integer`, default 0) to `tasks` table.

### Status arrays to update

- `INFLIGHT_STATUSES` in dispatcher.ts: add `'awaiting_ai_review'`
- `ALL_TASK_STATUSES` in budgets.ts: add `'awaiting_ai_review'`
- `POLLABLE_STATUSES` in poller.ts: unchanged (AI review tasks aren't polled for backend events)
- `MISSION_TERMINAL_TASK_STATUSES` in reconciler.ts: unchanged (not terminal)
- Dispatcher test: update count from 7 → 8
- Web UI: task status badge needs a color for the new status

### Flow

```
awaiting_ci
  → CI passes + aiReviewEnabled=true  → awaiting_ai_review
  → CI passes + aiReviewEnabled=false → awaiting_review (unchanged)

awaiting_ai_review
  → AI approves                       → awaiting_review
  → AI rejects + retries < 3          → retry-with-feedback (stays awaiting_ai_review)
  → AI rejects + retries >= 3         → awaiting_review (escalate to human)
```

### Tick subsystem: `runAiReview`

Runs between CI poller and auto-merge in the tick loop.

```typescript
async function runAiReview(log): Promise<AiReviewResult> {
  // Find tasks in awaiting_ai_review with a PR
  // For each:
  //   1. Fetch PR diff via Octokit (pulls.get + compare)
  //   2. Build review prompt (mission goal + diff + task ledger summary)
  //   3. Call Anthropic messages.create directly (NOT an MA session)
  //   4. Parse response: { decision: 'approve' | 'reject', feedback: string }
  //   5. If approve: transition → awaiting_review, insert ledger event
  //   6. If reject + aiReviewRetryCount < 3:
  //        - sendTurn to original session with feedback
  //        - increment aiReviewRetryCount
  //        - transition back to awaiting_ci (agent will push fix, CI re-runs)
  //        - insert ledger event: ai_review.rejected
  //   7. If reject + aiReviewRetryCount >= 3:
  //        - transition → awaiting_review (human takes over)
  //        - insert ledger event: ai_review.escalated
  //   8. Record token usage from API response in task.costTokens
}
```

### Review prompt

```
You are reviewing a pull request opened by an automated coding agent.

## Mission goal
{mission.goal}

## PR diff
{diff}

## Agent activity summary
{task ledger events summary — key transitions, tool calls, errors}

## Instructions
Evaluate whether this PR achieves the mission goal correctly and safely.

Respond with JSON:
{
  "decision": "approve" or "reject",
  "feedback": "If rejecting, specific actionable feedback for the agent to fix the PR. If approving, a brief confirmation."
}

Approval criteria:
- The diff achieves what the mission goal asked for
- No obvious bugs, security issues, or regressions introduced
- Tests are included or existing tests still pass (CI already verified this)
- No unrelated changes or scope creep

Be pragmatic. Minor style issues are not grounds for rejection.
```

### Budget tracking

The direct API call returns token usage in the response. Add `usage.input_tokens + usage.output_tokens` to `task.costTokens` after each review call. This ensures the budget subsystem sees the spend.

### Short-circuit

To avoid re-reviewing on every tick while the agent is working on feedback, check for a recent `ai_review.rejected` ledger event. If one exists and the task is still in `awaiting_ai_review` (meaning the agent hasn't pushed a fix yet / CI hasn't re-run), skip this task for this tick.

Actually, the flow handles this naturally: after rejection, the task transitions back to `awaiting_ci`. It only returns to `awaiting_ai_review` after CI passes again. No short-circuit needed.

---

## 3. AGENTS.md Injection

### Overview

At dispatch time, fetch the repo's context file (AGENTS.md or CLAUDE.md) and prepend it to the agent prompt.

### File resolution order

Check in order, use the first one found:
1. `AGENTS.md` (repo root)
2. `.github/AGENTS.md`
3. `CLAUDE.md` (repo root)
4. `.claude/AGENTS.md`

### Fetch and cache

- Fetch at dispatch time via Octokit `repos.getContent({ owner, repo, path })`.
- Cache in-memory per `${repo}:${missionId}`. Clear when mission completes.
- Handle 404 (no file) and 403 (no permission) gracefully — skip, no error.
- Log which file was used (or none) in the `dispatcher.dispatched` ledger event.

### Size cap

- **8000 characters max** (~2000 tokens).
- If content exceeds cap, truncate and append: `\n\n[... truncated at 8000 chars. See full file in repo.]`
- Insert ledger event `dispatcher.agents_md_truncated` with the original size.

### Prompt assembly order

```
1. AGENTS.md / CLAUDE.md content  (repo context)
   ---
2. Skill template                 (playbook, if attached)
   ---
3. Mission goal / LLM sub-goal   (what to do)
   ---
4. Memories                       (learned facts)
```

### Schema changes

None. This is purely a dispatcher enhancement. The cached content lives in-memory on the tick service.

---

## 4. Forge AGENTS.md

Write an `AGENTS.md` for the Forge repo itself describing:
- Monorepo structure (packages/db, apps/tick, apps/web)
- Tech stack (Drizzle/libSQL, Fastify, Next.js App Router, better-auth)
- Conventions (vitest for tests, pnpm workspaces, TypeScript strict)
- Testing expectations (pure functions extracted and tested, vitest.setup.ts stubs env)
- PR conventions (conventional commits, one feature per PR)

---

## 5. Interaction effects

### DAG + AI Review

If task B depends on task A, and task A passes CI but fails AI review, task A transitions back to `awaiting_ci`. Task B stays queued (correctly, since A is not `merged`). No special handling needed — the existing status-based gating handles this.

### AI Review + Budget

AI review token costs are attributed to the task's `costTokens`. The budget subsystem sums all task costs. No changes to budget logic needed.

### AGENTS.md + Prompt Size

With all features active, prompt becomes: AGENTS.md (≤2k tokens) + Skill (~500 tokens) + LLM sub-goal (~200 tokens) + Memories (~200 tokens) ≈ ~3k tokens of context. Well within MA's limits.

### New status + all subsystems

`awaiting_ai_review` must be added to:
- `taskStatus` enum in schema
- `INFLIGHT_STATUSES` in dispatcher (7→8)
- `ALL_TASK_STATUSES` in budgets
- Task status badge component in web UI
- Dispatcher test assertion (7→8)

Does NOT need adding to:
- `MISSION_TERMINAL_TASK_STATUSES` (not terminal)
- `POLLABLE_STATUSES` (no backend events to poll)

---

## 6. Migration summary

**Migration 0007:**
- ALTER tasks: rename `depends_on` → drop, add `depends_on_ids` (text JSON, nullable)
- ALTER tasks: add `ai_review_retry_count` (integer, default 0)
- ALTER missions: add `ai_review_enabled` (integer/boolean, default false)
- Add `awaiting_ai_review` to task status enum (code-level, not SQL — SQLite text columns don't enforce enums)

---

## 7. File inventory

### New files
- `apps/tick/src/llm-planner.ts` — LLM decomposition + DAG validation
- `apps/tick/src/ai-review.ts` — AI review subsystem
- `apps/tick/src/agents-md.ts` — AGENTS.md fetcher + cache
- `apps/tick/src/llm-planner.test.ts` — cycle detection, prompt parsing tests
- `apps/tick/src/ai-review.test.ts` — review prompt, retry logic tests
- `apps/tick/src/agents-md.test.ts` — file resolution, truncation tests
- `apps/web/src/lib/llm-planner.ts` — web-side planner calling the LLM
- `AGENTS.md` — Forge's own repo context file
- `packages/db/migrations/0007_autonomous.sql`

### Modified files
- `packages/db/src/schema.ts` — new status, new fields, dependsOnIds
- `apps/tick/src/dispatcher.ts` — dependency check, AGENTS.md injection
- `apps/tick/src/reconciler.ts` — dependency failure cascade
- `apps/tick/src/tick.ts` — add runAiReview subsystem
- `apps/tick/src/ci.ts` — conditional transition to awaiting_ai_review
- `apps/tick/src/env.ts` — (already has ANTHROPIC_API_KEY, no changes needed)
- `apps/tick/src/budgets.ts` — add awaiting_ai_review to ALL_TASK_STATUSES
- `apps/tick/src/poller.ts` — no changes (not pollable)
- `apps/tick/src/dispatcher.test.ts` — update inflight count assertion
- `apps/tick/src/reconciler.test.ts` — add dependency cascade tests
- `apps/web/src/lib/planner.ts` — call LLM planner when strategy is 'llm'
- `apps/web/src/components/task-status-badge.tsx` — new status color
- `apps/web/src/app/missions/new/new-mission-form.tsx` — aiReviewEnabled toggle
