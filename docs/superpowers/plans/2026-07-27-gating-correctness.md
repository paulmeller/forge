# Gating Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Forge auto-merging work that its own gates rejected, delegate merge-time gating to GitHub, observe the PRs Forge opens, and give the review queue an exit.

**Architecture:** Split the overloaded `awaiting_review` task status into `ready_to_merge` and `needs_human` so the type system — not a remembered `WHERE` clause — enforces which tasks auto-merge may touch. Replace the direct `pulls.merge` call with GitHub's native auto-merge so required checks gate the merge. Subscribe to `pull_request` events so externally-merged PRs stop rotting. Add Approve/Dismiss actions and a per-repo plan-approval policy.

**Tech Stack:** TypeScript, Next.js 16 (App Router, React Server Components, Server Actions), Drizzle ORM over libSQL/SQLite, Octokit (REST + GraphQL), vitest, pino.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-gating-correctness-design.md`. It governs; this plan implements it.
- `awaiting_review` is **removed** from the task status enum, not supplemented. No code path may keep using it.
- Status gates; `escalationReason` explains. Auto-merge must key on **status**, never on the reason column.
- `needs_human` stays mission-terminal. `ready_to_merge` becomes **non**-terminal.
- Migrations are generated with `pnpm --filter @forge/db db:generate` and **never hand-written**. Before committing, confirm the generated filename appears in `packages/db/migrations/meta/_journal.json`. A hand-written `0004_auth_tables.sql` was absent from the journal and therefore never ran in any environment, including production. Latest existing migration is `0012_opposite_vindicator` (journal idx 13).
- Every defect gets a test that **fails against today's code**. Each fix is mutation-tested: revert the fix, confirm a specific test fails, restore. A test that still passes with the fix reverted is not coverage and must be rewritten.
- Escalation reason values, exactly: `ai_review_rejected`, `verify_incomplete`, `gate_stall`, `auto_merge_failed`.
- Review decision values, exactly: `approved`, `changes_requested`, `commented`.
- Run `pnpm typecheck && pnpm -r lint && pnpm -r test` before every commit. All three must be clean.
- Do not extract secrets, read `.env` files for credential values, forge sessions, or bypass authentication for any reason.

---

## File Structure

**Modified — schema and migration**
- `packages/db/src/schema.ts` — `taskStatus` enum, new `escalationReason` enum + column, `reviewDecision` column, `RepoPolicy` type + `repoPolicy` column, `AutoMergePolicy.requireHumanApproval`
- `packages/db/migrations/` — one generated migration

**Modified — tick engine (status rename + escalation reasons)**
- `apps/web/src/server/tick/gates.ts` — `GateStatus`, `afterVerifyStatus`, `postCiStatus`
- `apps/web/src/server/tick/ci.ts` — default target status
- `apps/web/src/server/tick/verify.ts` — pass + escalation paths
- `apps/web/src/server/tick/ai-review.ts` — approve + escalation paths
- `apps/web/src/server/tick/reconciler.ts` — terminal set, stall sweep, stats query
- `apps/web/src/server/tick/state.ts`, `budgets.ts`, `guardrails.ts`, `dispatcher.ts` — status-set membership

**Modified — auto-merge**
- `apps/web/src/server/tick/auto-merge.ts` — candidate query, native auto-merge, required-checks gating, `requireHumanApproval`

**Modified — webhooks**
- `apps/web/src/app/(app)/api/forge/github/webhook/route.ts` — `pull_request`, `pull_request_review` handlers

**Modified — UI/lib surfaces**
- `apps/web/src/lib/status-labels.ts`, `merge-stepper.ts`, `home.ts`, `rollups.ts`, `triage-view.ts`, `repo-activity.ts`
- `apps/web/src/components/task-status-badge.tsx`
- `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`
- `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts` (comment only)

**Created**
- `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/review-actions.ts` — Approve/Dismiss server actions
- `apps/web/src/lib/repo-policy.ts` — read `repoPolicy` with defaults

---

## Task 1: Split the status, record the reason

The enum change breaks every consumer at once, so schema, migration, and all rename sites land in **one commit** to keep the build green. This is large but mechanical.

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/<generated>.sql`
- Modify: `apps/web/src/server/tick/{gates,ci,verify,ai-review,reconciler,state,budgets,guardrails,dispatcher}.ts`
- Modify: `apps/web/src/lib/{status-labels,merge-stepper,home,rollups,triage-view,repo-activity}.ts`
- Modify: `apps/web/src/components/task-status-badge.tsx`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`
- Test: `apps/web/src/server/tick/gates.test.ts`, `apps/web/src/server/tick/reconciler.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `TaskStatus` gains `'ready_to_merge' | 'needs_human'` and loses `'awaiting_review'`; `EscalationReason = 'ai_review_rejected' | 'verify_incomplete' | 'gate_stall' | 'auto_merge_failed'`; `tasks.escalationReason: EscalationReason | null`; `afterVerifyStatus(aiReviewEnabled: boolean): 'awaiting_ai_review' | 'ready_to_merge'`; `postCiStatus(opts): GateStatus` where `GateStatus = 'awaiting_verify' | 'awaiting_ai_review' | 'ready_to_merge'`

- [ ] **Step 1: Write the failing test for the gate routing**

Create `apps/web/src/server/tick/gates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { afterVerifyStatus, postCiStatus } from './gates';

describe('gate routing', () => {
  it('routes a clean verify pass to ready_to_merge, not a human queue', () => {
    expect(afterVerifyStatus(false)).toBe('ready_to_merge');
  });

  it('routes to AI review when it is enabled', () => {
    expect(afterVerifyStatus(true)).toBe('awaiting_ai_review');
  });

  it('routes green CI to self-verify when enabled and criteria exist', () => {
    expect(
      postCiStatus({ selfVerifyEnabled: true, hasAcceptanceCriteria: true, aiReviewEnabled: true }),
    ).toBe('awaiting_verify');
  });

  it('routes green CI straight to ready_to_merge when both gates are off', () => {
    expect(
      postCiStatus({
        selfVerifyEnabled: false,
        hasAcceptanceCriteria: false,
        aiReviewEnabled: false,
      }),
    ).toBe('ready_to_merge');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/gates.test.ts`
Expected: FAIL — received `'awaiting_review'`, expected `'ready_to_merge'`.

- [ ] **Step 3: Update the schema enum and add the columns**

In `packages/db/src/schema.ts`, replace `'awaiting_review',` inside the `taskStatus` array (currently line 56) with the two new values, keeping the rest of the array untouched:

```ts
export const taskStatus = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'ready_to_merge',
  'needs_human',
  'merging',
  'merged',
  'resolved',
  'abandoned',
  'failed',
] as const;
export type TaskStatus = (typeof taskStatus)[number];
```

Immediately after the `haltReason` block, add:

```ts
/**
 * Why a Task landed in `needs_human`. Diagnostic only — the gate is the
 * status. Auto-merge must never key on this column.
 */
export const escalationReason = [
  'ai_review_rejected',
  'verify_incomplete',
  'gate_stall',
  'auto_merge_failed',
] as const;
export type EscalationReason = (typeof escalationReason)[number];

/** A human's decision on the PR, mirrored from GitHub review events. */
export const reviewDecision = ['approved', 'changes_requested', 'commented'] as const;
export type ReviewDecision = (typeof reviewDecision)[number];
```

In the `tasks` table definition, directly after the `haltReason` column (currently line 197), add:

```ts
    escalationReason: text('escalation_reason', { enum: escalationReason }),
    reviewDecision: text('review_decision', { enum: reviewDecision }),
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @forge/db db:generate`
Expected: a new `packages/db/migrations/0013_*.sql`.

- [ ] **Step 5: Verify the migration is registered — do not skip**

Run: `grep -c "0013" packages/db/migrations/meta/_journal.json`
Expected: `1`. If it is `0`, the migrator will never run this file in any environment. Stop and investigate rather than hand-editing the journal.

Then open the generated `.sql` and confirm it contains an `ALTER TABLE tasks ADD ... escalation_reason` and `... review_decision`, plus a backfill of the status column. Drizzle will not write the backfill for you — append it manually inside the generated file, after the ALTERs, with a `--> statement-breakpoint` marker on its own line before it:

```sql
--> statement-breakpoint
UPDATE `tasks` SET `status` = 'needs_human' WHERE `status` = 'awaiting_review';
```

Existing rows become `needs_human`: their escalation reason cannot be reconstructed, and the conservative direction never auto-merges something it should not.

- [ ] **Step 6: Update the gate router**

Replace `apps/web/src/server/tick/gates.ts` in full:

```ts
export type GateStatus = 'awaiting_verify' | 'awaiting_ai_review' | 'ready_to_merge';

/**
 * Which gate a Task advances to *after* the self-verify gate — or after CI when
 * self-verify is off. Shared by `ci.ts` and `verify.ts` so the two can't drift.
 *
 * The clean path ends at `ready_to_merge`, never `needs_human`: reaching here
 * means every enabled gate passed. Escalations route to `needs_human` at their
 * own call sites, which also set an escalation reason.
 */
export function afterVerifyStatus(
  aiReviewEnabled: boolean,
): 'awaiting_ai_review' | 'ready_to_merge' {
  return aiReviewEnabled ? 'awaiting_ai_review' : 'ready_to_merge';
}

/**
 * Which status a green CI build routes to. Self-verify (when enabled and the
 * Task has acceptance criteria) runs first; otherwise it's the same choice as
 * `afterVerifyStatus`.
 */
export function postCiStatus(opts: {
  selfVerifyEnabled: boolean;
  hasAcceptanceCriteria: boolean;
  aiReviewEnabled: boolean;
}): GateStatus {
  if (opts.selfVerifyEnabled && opts.hasAcceptanceCriteria) return 'awaiting_verify';
  return afterVerifyStatus(opts.aiReviewEnabled);
}
```

- [ ] **Step 7: Run the gate test — it should now pass**

Run: `cd apps/web && pnpm vitest run src/server/tick/gates.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Update the clean-path call sites**

`apps/web/src/server/tick/ci.ts` line 243 — change the default parameter:

```ts
  targetStatus: 'ready_to_merge' | 'awaiting_ai_review' | 'awaiting_verify' = 'ready_to_merge',
```

`apps/web/src/server/tick/verify.ts` line 346 — the self-verify **pass** path sets `status: 'ready_to_merge'`.

`apps/web/src/server/tick/ai-review.ts` line 253 — the **approve** path sets `status: 'ready_to_merge'`.

- [ ] **Step 9: Update the escalation call sites to set a reason**

`apps/web/src/server/tick/verify.ts` — the escalation update (around line 346, the branch reached when there are no acceptance criteria, no new push, or verify retries are exhausted):

```ts
      status: 'needs_human',
      escalationReason: 'verify_incomplete',
```

`apps/web/src/server/tick/ai-review.ts` line 302 — the retries-exhausted branch:

```ts
      status: 'needs_human',
      escalationReason: 'ai_review_rejected',
```

`apps/web/src/server/tick/reconciler.ts` line 279 — the gate-stall sweep:

```ts
        status: 'needs_human',
        escalationReason: 'gate_stall',
```

`apps/web/src/server/tick/auto-merge.ts` line 177 — the rollback:

```ts
    .set({
      status: 'needs_human',
      escalationReason: 'auto_merge_failed',
      lastError: `auto-merge failed: ${mergeError ?? 'unknown'}`,
      updatedAt: errAt,
    })
```

- [ ] **Step 10: Update status-set membership**

Replace the string `'awaiting_review'` with **both** `'ready_to_merge'` and `'needs_human'` in these sets, because each describes "a Task that is past the agent-active phase":

- `apps/web/src/server/tick/state.ts:47` — the guard becomes `current === 'awaiting_ci' || current === 'ready_to_merge' || current === 'needs_human' || current === 'merged'`
- `apps/web/src/server/tick/budgets.ts:56` — inside `ALL_TASK_STATUSES`
- `apps/web/src/server/tick/dispatcher.ts:23`

In `apps/web/src/server/tick/reconciler.ts:52-58`, `MISSION_TERMINAL_TASK_STATUSES` gets **only** `'needs_human'` — not `'ready_to_merge'`. Add this comment above it:

```ts
// `ready_to_merge` is deliberately absent: a Mission must not call itself
// complete while a Task is merge-eligible but unmerged. `needs_human` stays
// terminal — the Mission has done everything it can without a person.
```

Update the prose-only references at `budgets.ts:43`, `guardrails.ts:34`, `reconciler.ts:34`, and `app/(app)/repos/[owner]/[repo]/actions.ts:127` to name the new statuses.

`apps/web/src/server/tick/reconciler.ts:503` — the stats query column:

```ts
      needsHuman: sql<number>`sum(case when ${tasks.status} = 'needs_human' then 1 else 0 end)`,
```

Rename the consuming property wherever `awaitingReview` is read from that query result.

- [ ] **Step 11: Update the UI surfaces**

`apps/web/src/lib/status-labels.ts` — replace the `awaiting_review` entry:

```ts
  ready_to_merge: 'Ready to merge',
  needs_human: 'Needs you',
```

`apps/web/src/lib/home.ts:26`:

```ts
const NEEDS_YOU_STATUSES = ['needs_human', 'failed'] as const;
```

`apps/web/src/lib/repo-activity.ts:66` — the `eq(tasks.status, 'awaiting_review')` filter becomes `eq(tasks.status, 'needs_human')`, and update the doc comment at line 57 to match.

`apps/web/src/lib/triage-view.ts:117` — `if (fix.status === 'needs_human') return 'fix_review';`

`apps/web/src/lib/rollups.ts:77` — `else if (row.status === 'needs_human') c.awaitingReview += n;` (leave the counter name; renaming it is out of scope).

`apps/web/src/components/task-status-badge.tsx:14` and `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx:26` — replace the `awaiting_review: 'secondary',` entry with:

```ts
  ready_to_merge: 'secondary',
  needs_human: 'secondary',
```

`apps/web/src/lib/merge-stepper.ts` — in `PAST_CI`, replace `'awaiting_review'` with `'ready_to_merge'` and `'needs_human'`; change `needsAttention: status === 'awaiting_review'` to `status === 'needs_human'`. Leave the doc comment about the missing Review step alone — Task 4 rewrites it.

- [ ] **Step 12: Add a mission-terminality test**

Append to `apps/web/src/server/tick/reconciler.test.ts` (follow the existing describe/import style in that file):

```ts
import { MISSION_TERMINAL_TASK_STATUSES } from './reconciler';

describe('mission terminality', () => {
  it('does not treat ready_to_merge as terminal — unmerged work keeps a mission open', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('ready_to_merge');
  });

  it('treats needs_human as terminal — the mission has done all it can alone', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('needs_human');
  });
});
```

If `MISSION_TERMINAL_TASK_STATUSES` is not currently exported from `reconciler.ts`, export it.

- [ ] **Step 13: Full verification**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test`
Expected: all clean. Typecheck is the real gate here — it finds every `awaiting_review` you missed, because the value no longer exists in the union.

- [ ] **Step 14: Confirm nothing references the dead status**

Run: `grep -rn "awaiting_review" apps/web/src packages/db/src`
Expected: no output.

- [ ] **Step 15: Commit**

```bash
git add packages/db apps/web/src
git commit -m "fix(gates): split awaiting_review into ready_to_merge and needs_human"
```

---

## Task 2: Auto-merge only touches merge-eligible work, and GitHub gates the merge

**Files:**
- Modify: `apps/web/src/server/tick/auto-merge.ts`
- Modify: `packages/db/src/schema.ts` (`AutoMergePolicy.requireHumanApproval`)
- Test: `apps/web/src/server/tick/auto-merge.test.ts`

**Interfaces:**
- Consumes: `TaskStatus` with `'ready_to_merge' | 'needs_human'` (Task 1)
- Produces: `AutoMergePolicy` gains `requireHumanApproval?: boolean`; `evaluatePolicy` unchanged; new non-exported `enableNativeAutoMerge(gh, owner, repo, prNodeId)`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/server/tick/auto-merge.test.ts` (create it if absent, using the `vi.mock('@/lib/db')` scaffold from `apps/web/src/app/(app)/api/github/callback/route.test.ts`):

```ts
it('never selects a task that escalated to needs_human', async () => {
  // A task the AI reviewer rejected three times must not be merge-eligible,
  // however small its diff. This is the defect the split exists to prevent.
  await seedTask({ id: 'tsk_esc', status: 'needs_human', escalationReason: 'ai_review_rejected', prUrl: PR_URL });
  const res = await runAutoMerge(log);
  expect(res.candidates).toBe(0);
  expect(mergeSpy).not.toHaveBeenCalled();
});

it('refuses to merge when the repo has no required checks configured', async () => {
  await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
  requiredChecksSpy.mockResolvedValue([]);
  const res = await runAutoMerge(log);
  expect(res.merged).toBe(0);
  expect(res.blocked).toBe(1);
  expect(lastBlockedReasons()).toEqual(
    expect.arrayContaining([expect.stringContaining('no required checks')]),
  );
});

it('blocks when the policy names a check the repo does not require', async () => {
  await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
  requiredChecksSpy.mockResolvedValue(['build']);
  await setPolicy({ enabled: true, requiredChecks: ['build', 'e2e'] });
  const res = await runAutoMerge(log);
  expect(res.blocked).toBe(1);
  expect(lastBlockedReasons()).toEqual(
    expect.arrayContaining([expect.stringContaining('e2e')]),
  );
});

it('enables native auto-merge instead of merging directly', async () => {
  await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL });
  requiredChecksSpy.mockResolvedValue(['build']);
  await runAutoMerge(log);
  // GitHub owns the merge decision; we must not call pulls.merge ourselves.
  expect(mergeSpy).not.toHaveBeenCalled();
  expect(graphqlSpy).toHaveBeenCalledWith(
    expect.stringContaining('enablePullRequestAutoMerge'),
    expect.objectContaining({ pullRequestId: PR_NODE_ID }),
  );
});

it('skips unapproved tasks when the policy requires human approval', async () => {
  await seedTask({ id: 'tsk_ok', status: 'ready_to_merge', prUrl: PR_URL, approvedBy: null });
  await setPolicy({ enabled: true, requireHumanApproval: true });
  const res = await runAutoMerge(log);
  expect(res.merged).toBe(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge.test.ts`
Expected: FAIL — the candidate query still selects escalated tasks, and `pulls.merge` is still called.

- [ ] **Step 3: Add the policy field**

In `packages/db/src/schema.ts`, extend `AutoMergePolicy`:

```ts
export type AutoMergePolicy = {
  enabled: boolean;
  maxAdditions?: number;
  maxDeletions?: number;
  maxFilesChanged?: number;
  requiredChecks?: string[];
  allowedPathPatterns?: string[];
  /**
   * When true, only Tasks a human approved (see the Approve action) are
   * merge-eligible. Defaults false: unattended auto-merge stays a real
   * feature, but operators who want Renovate-style approval can have it.
   */
  requireHumanApproval?: boolean;
};
```

Add an `approvedBy` column to `tasks`, directly after `reviewDecision`:

```ts
    approvedBy: text('approved_by'),
```

Regenerate and verify the migration exactly as in Task 1 Steps 4-5.

- [ ] **Step 4: Narrow the candidate query**

In `apps/web/src/server/tick/auto-merge.ts`, change line 56:

```ts
    .where(and(eq(tasks.status, 'ready_to_merge'), isNotNull(tasks.prUrl)));
```

and replace the function doc comment above `runAutoMerge`:

```ts
/**
 * For each Mission with an auto-merge policy, find `ready_to_merge` Tasks
 * whose PR shape matches the policy and hand them to GitHub's native
 * auto-merge.
 *
 * `needs_human` Tasks are structurally excluded: the status split exists so
 * that a Task which failed AI review, failed self-verify, stalled in a gate,
 * or bounced off a previous merge attempt can never be selected here — a
 * small diff is not evidence that rejected work is safe.
 */
```

- [ ] **Step 5: Add the approval check**

Immediately after the `if (!policy?.enabled) continue;` line:

```ts
    if (policy.requireHumanApproval && !row.task.approvedBy) continue;
```

- [ ] **Step 6: Replace the merge with native auto-merge**

In `tryMerge`, replace the whole block from `// Transition to merging` through the `if (mergeOk)` branch. Required checks are read first, and an unprotected branch blocks rather than merging:

```ts
  // Merge-time gating belongs to GitHub, not to us. Read the branch's
  // required checks; an empty set means nothing would gate the merge, so
  // native auto-merge would fire instantly — block instead of pretending
  // the diff-shape check made that safe.
  const required = await requiredChecksFor(gh, owner, repo, pr.base.ref);
  if (required.length === 0) {
    await markBlocked(task, mission, pullNumber, [
      `branch '${pr.base.ref}' has no required checks configured — refusing to auto-merge`,
    ]);
    return 'blocked';
  }

  const missingChecks = (policy.requiredChecks ?? []).filter((c) => !required.includes(c));
  if (missingChecks.length > 0) {
    await markBlocked(task, mission, pullNumber, [
      `policy requires checks the branch does not: ${missingChecks.join(', ')}`,
    ]);
    return 'blocked';
  }

  const now = new Date();
  await db.update(tasks).set({ status: 'merging', updatedAt: now }).where(eq(tasks.id, task.id));

  let mergeError: string | null = null;
  try {
    await gh.graphql(
      `mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { pullRequestId: pr.node_id },
    );
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }

  if (!mergeError) {
    // Armed, not merged. GitHub merges when the required checks pass; the
    // pull_request webhook moves this Task to `merged` when that happens.
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'auto_merge.armed',
      payload: {
        prNumber: pullNumber,
        method: 'squash',
        requiredChecks: required,
        additions: pr.additions,
        deletions: pr.deletions,
        filesChanged: pr.changed_files,
      },
      createdAt: new Date(),
    });
    return 'merged';
  }
```

The rollback block that follows is unchanged apart from the `needs_human` / `auto_merge_failed` edit already made in Task 1.

- [ ] **Step 7: Add the required-checks reader**

Append to `apps/web/src/server/tick/auto-merge.ts`:

```ts
/**
 * Required status checks on a branch, or [] when the branch is unprotected.
 * A 404 means no protection rule exists — that is a normal answer here, not
 * an error, so it maps to the empty set rather than throwing.
 */
async function requiredChecksFor(
  gh: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string[]> {
  try {
    const { data } = await gh.repos.getBranchProtection({ owner, repo, branch });
    return data.required_status_checks?.contexts ?? [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 8: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge.test.ts`
Expected: PASS.

- [ ] **Step 9: Mutation-test the security property**

Temporarily widen the candidate query back to include `needs_human`, re-run the suite, and confirm the "never selects a task that escalated" test **fails**. Restore the narrow query and confirm the suite is green again. If that test passed while the query was wide, it is not testing what it claims — rewrite it before continuing.

- [ ] **Step 10: Full verification and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add packages/db apps/web/src/server/tick/auto-merge.ts apps/web/src/server/tick/auto-merge.test.ts
git commit -m "fix(auto-merge): delegate merge gating to GitHub required checks"
```

---

## Task 3: Observe the PRs Forge opens

**Files:**
- Modify: `apps/web/src/app/(app)/api/forge/github/webhook/route.ts`
- Test: `apps/web/src/app/(app)/api/forge/github/webhook/route.test.ts`

**Interfaces:**
- Consumes: `tasks.reviewDecision` (Task 1), `TaskStatus` (Task 1)
- Produces: nothing consumed by later code tasks

- [ ] **Step 1: Write the failing tests**

Add to the webhook route's test file, following its existing signed-request helper (the suite must sign bodies with the test `GITHUB_WEBHOOK_SECRET`, since an unsigned request 401s before routing):

```ts
it('marks the task merged when a human merges the PR on GitHub', async () => {
  await seedTask({ id: 'tsk_1', status: 'ready_to_merge', prUrl: PR_URL });
  const res = await postSigned('pull_request', {
    action: 'closed',
    pull_request: { html_url: PR_URL, merged: true },
  });
  expect(res.status).toBe(200);
  expect(await statusOf('tsk_1')).toBe('merged');
});

it('abandons the task when the PR is closed unmerged', async () => {
  await seedTask({ id: 'tsk_2', status: 'ready_to_merge', prUrl: PR_URL });
  await postSigned('pull_request', {
    action: 'closed',
    pull_request: { html_url: PR_URL, merged: false },
  });
  expect(await statusOf('tsk_2')).toBe('abandoned');
});

it('records a changes-requested review', async () => {
  await seedTask({ id: 'tsk_3', status: 'ready_to_merge', prUrl: PR_URL });
  await postSigned('pull_request_review', {
    action: 'submitted',
    review: { state: 'changes_requested' },
    pull_request: { html_url: PR_URL },
  });
  expect(await reviewDecisionOf('tsk_3')).toBe('changes_requested');
});

it('ignores events for PRs Forge did not open', async () => {
  const res = await postSigned('pull_request', {
    action: 'closed',
    pull_request: { html_url: 'https://github.com/x/y/pull/999', merged: true },
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && pnpm vitest run "src/app/(app)/api/forge/github/webhook/route.test.ts"`
Expected: FAIL — the route returns `{ ignored: true }` for both events.

- [ ] **Step 3: Route the new events**

In `POST`, after the `check_suite` branch:

```ts
  if (event === 'pull_request') {
    return handlePullRequest(rawBody);
  }

  if (event === 'pull_request_review') {
    return handlePullRequestReview(rawBody);
  }
```

- [ ] **Step 4: Implement the handlers**

Append to the same file:

```ts
type PullRequestPayload = {
  action?: string;
  pull_request?: { html_url?: string; merged?: boolean };
  review?: { state?: string };
};

/** Tasks are keyed by the PR URL Forge recorded when it opened the PR. */
async function taskByPrUrl(prUrl: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.prUrl, prUrl)).limit(1);
  return row ?? null;
}

/**
 * Closing the loop on PRs Forge opened. Without this a human merging on
 * GitHub was never observed, so the Task sat in the review queue forever
 * while its Mission had already auto-completed around it.
 */
async function handlePullRequest(rawBody: string) {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (payload.action !== 'closed') {
    return NextResponse.json({ ignored: true, action: payload.action }, { status: 200 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return NextResponse.json({ ignored: true }, { status: 200 });

  const task = await taskByPrUrl(prUrl);
  if (!task) return NextResponse.json({ ignored: true, reason: 'unknown pr' }, { status: 200 });

  const now = new Date();
  const status = payload.pull_request?.merged ? 'merged' : 'abandoned';
  await db
    .update(tasks)
    .set({ status, updatedAt: now, completedAt: now })
    .where(eq(tasks.id, task.id));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: payload.pull_request?.merged ? 'pr.merged' : 'pr.closed',
    payload: { prUrl },
    createdAt: now,
  });

  return NextResponse.json({ ok: true, status }, { status: 200 });
}

const REVIEW_STATES: Record<string, 'approved' | 'changes_requested' | 'commented'> = {
  approved: 'approved',
  changes_requested: 'changes_requested',
  commented: 'commented',
};

async function handlePullRequestReview(rawBody: string) {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return NextResponse.json({ ignored: true }, { status: 200 });

  const task = await taskByPrUrl(prUrl);
  if (!task) return NextResponse.json({ ignored: true, reason: 'unknown pr' }, { status: 200 });

  // A dismissed review clears the decision — the PR is unreviewed again.
  const decision =
    payload.action === 'dismissed'
      ? null
      : (REVIEW_STATES[payload.review?.state?.toLowerCase() ?? ''] ?? null);

  await db
    .update(tasks)
    .set({ reviewDecision: decision, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  return NextResponse.json({ ok: true, decision }, { status: 200 });
}
```

Add `tasks`, `ledgerEvents`, `randomUUID`, `eq`, and `db` to the file's imports if they are not already present.

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && pnpm vitest run "src/app/(app)/api/forge/github/webhook/route.test.ts"`
Expected: PASS.

- [ ] **Step 6: Subscribe the GitHub App to the new events**

This is app configuration, not code — without it the handlers never fire. The app's events are currently `check_suite, issue_comment, push`.

There is no REST endpoint to change an App's event subscriptions; they are edited in the App settings UI. Go to **https://github.com/settings/apps/forge-local-udd8ld** → **Permissions & events** → **Subscribe to events**, tick **Pull request** and **Pull request review**, and save.

Then verify against the API rather than trusting the UI. Save as `/tmp/check-events.mjs`:

```js
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('apps/web/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const pem = (env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/^"|"$/g, '').replaceAll('\\n', '\n');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
const jwt = `${input}.${createSign('RSA-SHA256').update(input).sign(pem).toString('base64url')}`;
const res = await fetch('https://api.github.com/app', {
  headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
});
const app = await res.json();
console.log('events:', (app.events ?? []).join(', '));
```

Run: `node /tmp/check-events.mjs`
Expected output contains both `pull_request` and `pull_request_review`. Do not mark this step done on the basis of the settings UI alone.

- [ ] **Step 7: Full verification and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add "apps/web/src/app/(app)/api/forge/github/webhook"
git commit -m "feat(webhooks): observe pull_request and review events"
```

---

## Task 4: An honest Review step in the stepper

**Files:**
- Modify: `apps/web/src/lib/merge-stepper.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx` (render the third step)
- Test: `apps/web/src/lib/merge-stepper.test.ts`

**Interfaces:**
- Consumes: `tasks.reviewDecision` (Task 1), populated by Task 3
- Produces: `MergeStepperState` gains a `review: StepState` field on the `steps` variant

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/lib/merge-stepper.test.ts`:

```ts
it('shows Review as active while a PR is unreviewed', () => {
  const s = deriveMergeStepper('ready_to_merge', PR, null);
  expect(s).toMatchObject({ kind: 'steps', ci: 'done', review: 'active', merge: 'upcoming' });
});

it('shows Review as done once approved', () => {
  const s = deriveMergeStepper('ready_to_merge', PR, 'approved');
  expect(s).toMatchObject({ kind: 'steps', review: 'done' });
});

it('flags attention when changes are requested', () => {
  const s = deriveMergeStepper('ready_to_merge', PR, 'changes_requested');
  expect(s).toMatchObject({ kind: 'steps', review: 'active', needsAttention: true });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/web && pnpm vitest run src/lib/merge-stepper.test.ts`
Expected: FAIL — `deriveMergeStepper` takes two parameters and returns no `review`.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/merge-stepper.ts`, replace the type, the doc comment, and the signature:

```ts
export type MergeStepperState =
  | { kind: 'hidden' }
  | { kind: 'failed' }
  | {
      kind: 'steps';
      ci: StepState;
      review: StepState;
      merge: StepState;
      needsAttention: boolean;
    };

const PAST_CI = new Set<TaskStatus>([
  'awaiting_verify',
  'awaiting_ai_review',
  'ready_to_merge',
  'needs_human',
  'merging',
  'merged',
]);

/**
 * Derives a 3-step CI -> Review -> Merge display from the task's real state.
 *
 * The Review step is driven by `reviewDecision`, mirrored from GitHub's
 * pull_request_review events. Before those were subscribed there was no
 * signal to drive it, which is why this used to be an honest 2-step display.
 */
export function deriveMergeStepper(
  status: TaskStatus,
  prUrl: string | null,
  reviewDecision: ReviewDecision | null,
): MergeStepperState {
  if (!prUrl) return { kind: 'hidden' };
  if (status === 'failed') return { kind: 'failed' };

  if (status === 'awaiting_ci') {
    return {
      kind: 'steps',
      ci: 'active',
      review: 'upcoming',
      merge: 'upcoming',
      needsAttention: false,
    };
  }

  if (PAST_CI.has(status)) {
    const review: StepState = reviewDecision === 'approved' ? 'done' : 'active';
    return {
      kind: 'steps',
      ci: 'done',
      review: status === 'merged' ? 'done' : review,
      merge: status === 'merged' ? 'done' : status === 'merging' ? 'active' : 'upcoming',
      needsAttention: status === 'needs_human' || reviewDecision === 'changes_requested',
    };
  }

  return { kind: 'hidden' };
}
```

Import `ReviewDecision` from `@forge/db` alongside `TaskStatus`.

- [ ] **Step 4: Update the caller**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`, pass the task's `reviewDecision` as the third argument to `deriveMergeStepper`. `ActiveTaskInfo.mergeStepper` already carries `MergeStepperState`, so it picks up the new field with no type change at the call site.

In the `MergeStepper` component in that file, add the Review step between the existing CI and Merge steps. The component already maps over its steps — extend the array it renders:

```tsx
const steps = [
  { key: 'ci', label: 'CI', state: s.ci },
  { key: 'review', label: 'Review', state: s.review },
  { key: 'merge', label: 'Merge', state: s.merge },
] as const;
```

Each step already renders as:

```tsx
<Badge
  variant={step.state === 'done' ? 'default' : step.state === 'active' ? 'secondary' : 'outline'}
  className={cn('gap-1', step.state === 'upcoming' && 'text-muted-foreground')}
>
  {step.state === 'done' ? <Check data-icon="inline-start" /> : null}
  {step.label}
</Badge>
```

Keep that markup exactly; only the array gains an entry.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/lib/merge-stepper.ts apps/web/src/lib/merge-stepper.test.ts "apps/web/src/app/(app)/repos"
git commit -m "feat(ui): add a Review step now that review state is tracked"
```

---

## Task 5: Approve and Dismiss

**Files:**
- Create: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/review-actions.ts`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`
- Test: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/review-actions.test.ts`

**Interfaces:**
- Consumes: `tasks.escalationReason`, `tasks.approvedBy` (Tasks 1-2), `getTask(id, userId)` from `@/lib/tasks`
- Produces: `reviewAction(formData: FormData): Promise<ReviewActionState>`, reading `taskId` and `op` (`'approve' | 'dismiss'`) from the form. Single-argument so it can be used directly as a `form action`.

- [ ] **Step 1: Write the failing tests**

```ts
it('approve moves needs_human to ready_to_merge and clears the reason', async () => {
  await seedTask({ id: 'tsk_1', status: 'needs_human', escalationReason: 'ai_review_rejected' });
  await reviewAction(formData({ taskId: 'tsk_1', op: 'approve' }));
  const t = await getTaskRow('tsk_1');
  expect(t.status).toBe('ready_to_merge');
  expect(t.escalationReason).toBeNull();
  expect(t.approvedBy).toBe('u1');
});

it('dismiss abandons the task', async () => {
  await seedTask({ id: 'tsk_2', status: 'needs_human' });
  await reviewAction(formData({ taskId: 'tsk_2', op: 'dismiss' }));
  expect((await getTaskRow('tsk_2')).status).toBe('abandoned');
});

it('refuses a task belonging to another user', async () => {
  await seedTask({ id: 'tsk_3', status: 'needs_human', userId: 'someone_else' });
  const res = await reviewAction(formData({ taskId: 'tsk_3', op: 'approve' }));
  expect(res.error).toBe('task not found');
  expect((await getTaskRow('tsk_3')).status).toBe('needs_human');
});

it('refuses to approve a task that is not awaiting a human', async () => {
  await seedTask({ id: 'tsk_4', status: 'running' });
  const res = await reviewAction(formData({ taskId: 'tsk_4', op: 'approve' }));
  expect(res.error).toBeDefined();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/web && pnpm vitest run "src/app/(app)/missions/[missionId]/tasks/[taskId]/review-actions.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the actions**

```ts
'use server';

import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';
import { revalidatePath } from 'next/cache';

import { ledgerEvents, tasks } from '@forge/db';

import { db } from '@/lib/db';
import { getTask } from '@/lib/tasks';
import { withAuth } from '@/lib/with-auth';

export type ReviewActionState = { error?: string; ok?: boolean };

/**
 * Clears a Task out of `needs_human` — the exit the review queue never had.
 *
 * Server Actions are POST endpoints reachable without rendering the page, so
 * withAuth() runs first and getTask() is ownership-scoped: approving another
 * account's Task would otherwise be a one-request privilege escalation into
 * their auto-merge pipeline.
 */
export async function reviewAction(formData: FormData): Promise<ReviewActionState> {
  const user = await withAuth();

  const taskId = formData.get('taskId');
  const op = formData.get('op');
  if (typeof taskId !== 'string') return { error: 'missing taskId' };
  if (op !== 'approve' && op !== 'dismiss') return { error: 'invalid op' };
  const operation: 'approve' | 'dismiss' = op;

  const task = await getTask(taskId, user.id);
  if (!task) return { error: 'task not found' };
  if (task.status !== 'needs_human') {
    return { error: `task is ${task.status}, not awaiting a human` };
  }

  const now = new Date();
  if (operation === 'approve') {
    await db
      .update(tasks)
      .set({
        status: 'ready_to_merge',
        escalationReason: null,
        approvedBy: user.id,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));
  } else {
    await db
      .update(tasks)
      .set({ status: 'abandoned', updatedAt: now, completedAt: now })
      .where(eq(tasks.id, task.id));
  }

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: operation === 'approve' ? 'review.approved' : 'review.dismissed',
    payload: { by: user.id, previousEscalationReason: task.escalationReason },
    createdAt: now,
  });

  revalidatePath(`/missions/${task.missionId}/tasks/${task.id}`);
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests**

Expected: PASS, 4 tests.

- [ ] **Step 5: Render the buttons**

Add to `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`, inside the `Run` card and above `SessionLogView`. `Alert` and `Button` are already installed.

```tsx
const ESCALATION_COPY: Record<string, string> = {
  ai_review_rejected: 'The AI reviewer rejected this three times.',
  verify_incomplete: 'Self-verify could not confirm the work was complete.',
  gate_stall: 'A validator kept erroring, so this was escalated automatically.',
  auto_merge_failed: 'An auto-merge attempt failed and was rolled back.',
};
```

```tsx
{task.status === 'needs_human' ? (
  <Alert>
    <AlertTitle className="text-sm">Needs your decision</AlertTitle>
    <AlertDescription className="text-xs">
      {ESCALATION_COPY[task.escalationReason ?? ''] ?? 'This task was escalated for review.'}
      {' Approving makes it eligible for auto-merge.'}
    </AlertDescription>
    <form action={reviewAction} className="mt-3 flex gap-2">
      <input type="hidden" name="taskId" value={task.id} />
      <Button type="submit" name="op" value="approve">
        Approve
      </Button>
      <Button type="submit" name="op" value="dismiss" variant="outline">
        Dismiss
      </Button>
    </form>
  </Alert>
) : null}
```

Note both buttons submit the same form with different `value`s on a shared `name="op"` — that is why `reviewAction` reads `op` from `formData` rather than taking it as an argument. Import `reviewAction` from `./review-actions`, and `Alert`/`AlertTitle`/`AlertDescription` from `@/components/ui/alert`.

`reviewAction` takes a single `FormData` argument precisely so it can be used directly as a `form action`. It returns state for the tests to assert on; the page is a server component and re-renders via `revalidatePath`, so the return value is unused in the JSX.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add "apps/web/src/app/(app)/missions"
git commit -m "feat(review): add Approve and Dismiss actions for needs_human"
```

---

## Task 6: Per-repo plan-approval policy for `@forge`

**Files:**
- Modify: `packages/db/src/schema.ts` (`RepoPolicy`, `repoPolicy` column)
- Create: `apps/web/src/lib/repo-policy.ts`
- Modify: `apps/web/src/lib/dispatch-from-github.ts`
- Test: `apps/web/src/lib/dispatch-from-github.test.ts`

**Interfaces:**
- Consumes: `runPlanner(missionId)` from `@/lib/planner`
- Produces: `RepoPolicy = { requirePlanApproval: boolean }`; `getRepoPolicy(repoFullName: string): Promise<RepoPolicy>` defaulting to `{ requirePlanApproval: true }`

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a mission awaiting plan approval by default', async () => {
  const { mission } = await dispatchFromGithub({
    repoFullName: 'a/b', goal: 'fix it', defaultBranch: 'main', triggeredBy: 'octocat',
  });
  // Default is gated: @forge must not dispatch straight to an agent.
  expect((await missionRow(mission.id)).status).toBe('planning');
});

it('does not dispatch a gated mission', async () => {
  const { mission } = await dispatchFromGithub({
    repoFullName: 'a/b', goal: 'fix it', defaultBranch: 'main', triggeredBy: 'octocat',
  });
  const res = await runDispatcher(log);
  expect(res.dispatched).toBe(0);
  expect((await missionRow(mission.id)).status).toBe('planning');
});

it('runs immediately when the repo opts out', async () => {
  await setRepoPolicy('a/b', { requirePlanApproval: false });
  const { mission } = await dispatchFromGithub({
    repoFullName: 'a/b', goal: 'fix it', defaultBranch: 'main', triggeredBy: 'octocat',
  });
  expect((await missionRow(mission.id)).status).toBe('running');
});
```

- [ ] **Step 2: Run and watch fail**

Expected: FAIL — the mission is created `running` regardless.

- [ ] **Step 3: Add the schema**

```ts
/**
 * Per-repo policy. JSON rather than one column per setting so later settings
 * do not each need a migration, and so this can later be sourced from
 * versioned config when policy-as-code lands.
 */
export type RepoPolicy = {
  requirePlanApproval: boolean;
};
```

Add to `githubInstallationRepos`:

```ts
    repoPolicy: text('repo_policy', { mode: 'json' }).$type<RepoPolicy>(),
```

Regenerate and verify the migration as in Task 1 Steps 4-5.

- [ ] **Step 4: Add the reader**

Create `apps/web/src/lib/repo-policy.ts`:

```ts
import { eq } from '@forge/db/orm';

import { githubInstallationRepos, type RepoPolicy } from '@forge/db';

import { db } from './db';

/**
 * Gated by default. An unconfigured repo is one nobody has made a decision
 * about, and dispatching an agent is the less reversible of the two options.
 */
export const DEFAULT_REPO_POLICY: RepoPolicy = { requirePlanApproval: true };

export async function getRepoPolicy(repoFullName: string): Promise<RepoPolicy> {
  const [row] = await db
    .select({ policy: githubInstallationRepos.repoPolicy })
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.repo, repoFullName))
    .limit(1);
  return { ...DEFAULT_REPO_POLICY, ...(row?.policy ?? {}) };
}
```

- [ ] **Step 5: Gate the dispatch**

In `apps/web/src/lib/dispatch-from-github.ts`, before the transaction:

```ts
  const policy = await getRepoPolicy(input.repoFullName);
```

Change the mission insert's `status` (line 67) and `startedAt`:

```ts
        status: policy.requirePlanApproval ? 'draft' : 'running',
        startedAt: policy.requirePlanApproval ? null : now,
```

After the transaction returns, when gated, run the planner so a human has something to approve, and comment the approval link on the issue:

```ts
  if (policy.requirePlanApproval) {
    // Plan now so the operator reviews real Tasks rather than an empty
    // mission; startMission() remains the only path to `running`.
    await runPlanner(missionId);
    await commentPlanLink(input, missionId);
  }
```

No issue-comment helper exists anywhere in the repo today — `dispatch-from-github.ts` has no GitHub client at all — so add one to this module, using the same `GITHUB_APP_TOKEN` client pattern `auto-merge.ts` already uses rather than introducing a second auth mechanism:

```ts
import { Octokit } from '@octokit/rest';

const ISSUE_REF_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/**
 * Tells the commenter where to approve the plan. Best-effort: a failure to
 * comment must not undo a Mission that was created successfully, so this
 * swallows errors rather than throwing into the dispatch path.
 */
async function commentPlanLink(input: GithubDispatchInput, missionId: string): Promise<void> {
  if (!input.issueRef || !env.GITHUB_APP_TOKEN || !env.BETTER_AUTH_URL) return;
  const m = ISSUE_REF_RE.exec(input.issueRef);
  if (!m) return;
  const [, owner, repo, numStr] = m;
  try {
    await new Octokit({ auth: env.GITHUB_APP_TOKEN }).issues.createComment({
      owner: owner!,
      repo: repo!,
      issue_number: Number(numStr),
      body:
        `Planned this mission. Review and approve it to start: ` +
        `${env.BETTER_AUTH_URL}/missions/${missionId}/plan`,
    });
  } catch {
    // Non-fatal — the Mission exists and is visible in the UI regardless.
  }
}
```

Also update the module doc comment on `dispatchFromGithub`, which currently claims the Mission "goes draft → planning → running in one shot since the operator already gave the command externally". That is now conditional:

```ts
/**
 * Spawns a one-Task Mission scoped to a single repo, kicked off by a
 * GitHub @-mention or reaction.
 *
 * Whether it runs immediately depends on the repo's `requirePlanApproval`
 * policy, which defaults to true. An @-mention is a request, not plan
 * approval — the UI path has always required a human to review the plan
 * before dispatch, and this is what stops @forge being the one way in that
 * skips that gate.
 */

- [ ] **Step 6: Run the tests**

Expected: PASS.

- [ ] **Step 7: Mutation-test the gate**

Force `requirePlanApproval` to `false` in `DEFAULT_REPO_POLICY`, re-run, and confirm the default-gated test **fails**. Restore.

- [ ] **Step 8: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add packages/db apps/web/src/lib
git commit -m "feat(gates): @forge respects a per-repo plan-approval policy"
```

---

## Final verification

- [ ] `grep -rn "awaiting_review" apps/web/src packages/db/src` returns nothing
- [ ] `grep -c "0013\|0014\|0015" packages/db/migrations/meta/_journal.json` accounts for every migration generated
- [ ] `pnpm typecheck && pnpm -r lint && pnpm -r test` clean
- [ ] `GET /app` shows `pull_request` and `pull_request_review` in `events`
- [ ] Every mutation test in Tasks 2, 5 and 6 was actually run, not assumed
