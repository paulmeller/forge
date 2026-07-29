# Forge Owns the Branch and the Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Forge control the branch name and the pull request so it never has to guess what an agent produced.

**Architecture:** Every task's head branch is `forge/<taskId>` — derivable, unique, self-identifying. The agent is told to commit and push to exactly that name and not to open a PR. Forge checks GitHub for that one branch, sends a dictated salvage push if it is missing, and opens the PR itself. Branch discovery is deleted.

**Tech Stack:** Next.js 16 App Router, Drizzle over libSQL, Octokit, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-forge-owns-branch-and-push-design.md`. It governs.
- The branch name is **always** `forge/<taskId>`, computed by `forgeBranchName(taskId)`. Never hand-build it.
- Forge opens a PR **only** from `forge/<taskId>`. There is no discovery, no candidate list, no "any branch ahead of base".
- Every reconciler state change is a compare-and-swap guarded on the observed status (`.where(and(eq(tasks.id, …), eq(tasks.status, <observed>))).returning()`, then `if (!claimed) continue`). A non-idempotent side effect (`sendTurn`) claims the row **before** the effect.
- One salvage push per `turn_ended` cycle, gated by a `push.requested` ledger event — never per tick. Same pattern as `task.continued` (#51) and `ci.retry_dispatched` (#60).
- Business logic lives in `lib/` or a focused `server/tick/` module. Routes and sweeps stay thin.
- Mutation-test every behaviour: revert it, confirm a **specific named** test fails, restore. **Print the mutated source and confirm it changed before running** — no-op mutations have produced false green suites on this project.
- Report mutation results **per behaviour, never bundled**.
- No migration expected. The `escalationReason` column is a plain text enum (no CHECK constraint), so adding a value is code-only. If a migration ever seems needed, generate it with `pnpm --filter @forge/db db:generate`, never hand-write it, and grep-verify the tag in `packages/db/migrations/meta/_journal.json`.
- Run `pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test` before every commit; all three clean. Baseline is **1070 tests / 121 files**.
- If `apps/web/src/lib/api/schemas.ts` or the escalation enum changes, regenerate the spec with `pnpm api:spec` from the repo root and commit the result, or `openapi.test.ts` fails.
- Do not extract secrets, read `.env*` for credential values, forge sessions or cookies, bypass authentication, or start a dev server to log in.

---

## File Structure

**Created**
- `apps/web/src/server/tick/branch-name.ts` — `forgeBranchName(taskId)`, the single source of the name
- `apps/web/src/server/tick/branch-name.test.ts`
- `apps/web/src/server/tick/completion.ts` — `checkForgeBranch()`: does `forge/<taskId>` exist ahead of base
- `apps/web/src/server/tick/completion.test.ts`

**Modified**
- `packages/db/src/schema.ts` — add `no_commits` to the `escalationReason` enum
- `apps/web/src/server/tick/dispatcher.ts` — expose `{{forge_branch}}` to the goal template
- `AGENTS.md` — the push contract the agent reads
- `apps/web/src/server/tick/reconciler.ts` — exact-name PR open, salvage push, `no_commits` escalation; rework the reclaim sweep; delete discovery
- `apps/web/src/server/tick/reconciler-pr.test.ts`
- `docs/api/openapi.json` — regenerated for the new enum value

**Deleted**
- `apps/web/src/server/tick/branch-ownership.ts` and `branch-ownership.test.ts` — they exist only to serve discovery

---

## Task 1: The branch name

The one place the name is computed. Everything downstream depends on it, so it lands first.

**Files:**
- Create: `apps/web/src/server/tick/branch-name.ts`
- Create: `apps/web/src/server/tick/branch-name.test.ts`

**Interfaces:**
- Produces: `forgeBranchName(taskId: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/tick/branch-name.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { forgeBranchName } from './branch-name';

// Forge assigns this name and opens the PR from it. It is the fact that
// replaces every inference Forge used to make about an agent's output, so it
// must be derivable from the task id alone — no stored column, nothing to
// drift.
describe('forgeBranchName', () => {
  it('is derived from the task id', () => {
    expect(forgeBranchName('tsk_abc123')).toBe('forge/tsk_abc123');
  });

  it('is stable — the same task always maps to the same branch', () => {
    expect(forgeBranchName('tsk_abc123')).toBe(forgeBranchName('tsk_abc123'));
  });

  it('gives different tasks different branches', () => {
    expect(forgeBranchName('tsk_a')).not.toBe(forgeBranchName('tsk_b'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/branch-name.test.ts`
Expected: FAIL — cannot resolve `./branch-name`.

- [ ] **Step 3: Implement**

Create `apps/web/src/server/tick/branch-name.ts`:

```ts
/**
 * The branch Forge assigns to a task.
 *
 * Forge used to infer three things about an agent's output — whether it
 * pushed, which branch, and whether it was done — and each inference was a
 * defect. This name replaces all three: it is assigned before the agent runs,
 * so Forge can simply ask GitHub whether it exists rather than search for
 * something an agent chose.
 *
 * Derived from the task id rather than stored: nothing to keep in sync, and
 * the branch name alone identifies the task that produced it.
 */
export function forgeBranchName(taskId: string): string {
  return `forge/${taskId}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/branch-name.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/branch-name.ts apps/web/src/server/tick/branch-name.test.ts
git commit -m "feat(tick): the branch name Forge assigns to a task"
```

---

## Task 2: The completion check

"Is this task's work on the remote?" — one question, asked of GitHub, independent of any task flag. This is what makes stranded work impossible.

**Files:**
- Create: `apps/web/src/server/tick/completion.ts`
- Create: `apps/web/src/server/tick/completion.test.ts`

**Interfaces:**
- Consumes: `forgeBranchName` (Task 1)
- Produces: `checkForgeBranch(gh, opts): Promise<ForgeBranchState>` where

```ts
export type ForgeBranchState =
  | { present: false }
  | { present: true; aheadBy: number; filesChanged: number };
```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/tick/completion.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { checkForgeBranch } from './completion';

// Completion is a fact Forge checks, not a flag it infers: does the branch
// Forge named exist on the remote with commits on it? Asking GitHub directly
// is what lets this work from any task state, including a task a guardrail
// already halted.
function ghWith(compare: unknown, throws = false) {
  return {
    repos: {
      compareCommits: vi.fn(async () => {
        if (throws) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: compare };
      }),
    },
  };
}

const OPTS = { owner: 'acme', repo: 'api', baseBranch: 'main', taskId: 'tsk_1' };

describe('checkForgeBranch', () => {
  it('reports the branch present with its commit count when it is ahead of base', async () => {
    const gh = ghWith({ ahead_by: 2, files: [{ filename: 'a.ts' }, { filename: 'b.ts' }] });
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({
      present: true,
      aheadBy: 2,
      filesChanged: 2,
    });
  });

  it('compares the Forge-named branch, not anything the agent chose', async () => {
    const gh = ghWith({ ahead_by: 1, files: [] });
    await checkForgeBranch(gh as never, OPTS);
    expect(gh.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: 'forge/tsk_1' }),
    );
  });

  it('reports absent when the branch exists but has no commits on it', async () => {
    // A salvage push with nothing committed creates an empty branch. That is
    // not work, and must not open a pull request.
    const gh = ghWith({ ahead_by: 0, files: [] });
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({ present: false });
  });

  it('reports absent when the branch does not exist (compare 404s)', async () => {
    const gh = ghWith(null, true);
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({ present: false });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/completion.test.ts`
Expected: FAIL — cannot resolve `./completion`.

- [ ] **Step 3: Implement**

Create `apps/web/src/server/tick/completion.ts`:

```ts
import { forgeBranchName } from './branch-name';

/** Whether this task's Forge-named branch carries work on the remote. */
export type ForgeBranchState =
  | { present: false }
  | { present: true; aheadBy: number; filesChanged: number };

type CompareCapable = {
  repos: {
    compareCommits(params: {
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{ data: { ahead_by?: number; files?: unknown[] } }>;
  };
};

/**
 * Ask GitHub whether `forge/<taskId>` exists with commits ahead of base.
 *
 * This is Forge's definition of "the agent produced work". It deliberately
 * consults the remote rather than a task column, so it is correct from any
 * task state — including a task a guardrail halted before it could report in.
 * A missing branch 404s on compare, which is an answer, not an error.
 */
export async function checkForgeBranch(
  gh: CompareCapable,
  opts: { owner: string; repo: string; baseBranch: string; taskId: string },
): Promise<ForgeBranchState> {
  try {
    const { data } = await gh.repos.compareCommits({
      owner: opts.owner,
      repo: opts.repo,
      base: opts.baseBranch,
      head: forgeBranchName(opts.taskId),
    });
    const aheadBy = data.ahead_by ?? 0;
    if (aheadBy === 0) return { present: false };
    return { present: true, aheadBy, filesChanged: data.files?.length ?? 0 };
  } catch {
    // Branch absent (404) or compare unavailable — either way there is no
    // work to open a pull request from.
    return { present: false };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/completion.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test, per behaviour**

One at a time. Print the mutated source, confirm it changed, run, record the named failing test, restore.

1. Change `head: forgeBranchName(opts.taskId)` to `head: 'main'` → **"compares the Forge-named branch, not anything the agent chose"** must fail.
2. Change `if (aheadBy === 0) return { present: false };` to `if (false) …` → **"reports absent when the branch exists but has no commits on it"** must fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/completion.ts apps/web/src/server/tick/completion.test.ts
git commit -m "feat(tick): check completion against the Forge-named branch"
```

---

## Task 3: The agent's contract

Tell the agent the branch name and that Forge opens the PR. Without this the agent still improvises, and Tasks 4–5 fall back to the salvage push every time.

**Files:**
- Modify: `apps/web/src/server/tick/dispatcher.ts` (the `vars` block, ~line 227)
- Modify: `apps/web/src/server/tick/dispatcher.test.ts`
- Modify: `AGENTS.md` (repo root)

**Interfaces:**
- Consumes: `forgeBranchName` (Task 1)
- Produces: `{{forge_branch}}` available to every goal template

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/tick/dispatcher.test.ts`, inside the existing top-level `describe`:

```ts
  it('exposes the Forge-assigned branch to the goal template', async () => {
    // The agent cannot push to a name it was never told. This is the other
    // half of Forge owning the branch: Forge names it AND says so.
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });

    await dispatchOne(mission(), task('t1'));

    const { prompt } = mocks.adapter.createSession.mock.calls[0]![0];
    expect(prompt).toContain('forge/t1');
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/dispatcher.test.ts`
Expected: FAIL — the prompt does not contain `forge/t1`.

Note: the existing `task('t1')` helper builds a task whose id is `t1`, so the expected branch is `forge/t1`. Check the helper before assuming; if it prefixes ids, use the real id.

- [ ] **Step 3: Implement**

In `apps/web/src/server/tick/dispatcher.ts`, add the import:

```ts
import { forgeBranchName } from './branch-name';
```

and extend the `vars` block:

```ts
  const vars: Record<string, unknown> = {
    repo: task.repo,
    base_branch: task.baseBranch,
    // The branch Forge will open the pull request from. Exposed so a goal
    // template can name it explicitly; AGENTS.md instructs the agent to push
    // here and not to open a PR itself (it cannot — the sandbox egress
    // allowlist omits api.github.com).
    forge_branch: forgeBranchName(task.id),
    ...((task.promptVars as Record<string, unknown>) ?? {}),
  };
```

Then append this section to `AGENTS.md` at the repo root, immediately after the existing "Verify before pushing" section:

```markdown
## Pushing your work

Commit your work, then push it to the branch Forge assigned for this task:

```bash
git push origin HEAD:forge/<taskId>
```

The exact branch name is given in your task instructions. Push to that name and
no other — Forge opens the pull request from it, and a branch under a different
name is not something Forge will find.

**Do not open a pull request yourself.** The sandbox can reach `github.com` but
not `api.github.com`, so `gh pr create` cannot work. Push the branch and stop;
Forge opens the PR and runs it through CI.
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/dispatcher.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Mutation-test**

Remove `forge_branch: forgeBranchName(task.id),` from the `vars` block → **"exposes the Forge-assigned branch to the goal template"** must fail. Print the mutated source first, then restore.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/dispatcher.ts apps/web/src/server/tick/dispatcher.test.ts AGENTS.md
git commit -m "feat(dispatch): tell the agent the branch Forge assigned"
```

---

## Task 4: Open the PR from the Forge-named branch, and delete discovery

Replace the guessing machinery with the exact-name check. This is the task that removes the heuristic #56 exists to eliminate.

**Files:**
- Modify: `apps/web/src/server/tick/reconciler.ts`
- Modify: `apps/web/src/server/tick/reconciler-pr.test.ts`
- Delete: `apps/web/src/server/tick/branch-ownership.ts`, `apps/web/src/server/tick/branch-ownership.test.ts`

**Interfaces:**
- Consumes: `forgeBranchName` (Task 1), `checkForgeBranch` (Task 2)
- Produces: `tryOpenPr(task, mission, log): Promise<boolean>` — unchanged signature, exact-name behaviour

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/server/tick/reconciler-pr.test.ts`, add:

```ts
  it('opens the PR from the Forge-named branch', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_1' });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/9', number: 9 },
    });

    await runReconciler(noopLog);

    // Compared and opened against forge/<taskId> — never a discovered name.
    expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
  });

  it('never adopts a branch the agent named itself', async () => {
    // The old discovery would list the repo and adopt anything ahead of base.
    // With an exact-name check there is nothing to discover: an agent branch
    // is simply not this task's branch.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_2' });

    mockOctokit.repos.listBranches.mockResolvedValue({
      data: [{ name: 'claude/some-slug' }],
    });
    // forge/<taskId> does not exist — compare 404s.
    mockOctokit.repos.compareCommits.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts`
Expected: FAIL — the current code compares candidate/discovered names, not `forge/<taskId>`.

- [ ] **Step 3: Rewrite `tryOpenPr`**

In `apps/web/src/server/tick/reconciler.ts`, replace the whole body of `tryOpenPr` from `const [owner, repo] = task.repo.split('/');` down to the end of the candidate `for` loop with a single exact-name path. Keep the existing PR-title derivation and the existing-PR branch verbatim — only the branch selection changes:

```ts
async function tryOpenPr(
  task: typeof tasks.$inferSelect,
  mission: typeof missions.$inferSelect,
  log: Logger,
): Promise<boolean> {
  const [owner, repo] = task.repo.split('/');
  if (!owner || !repo) return false;

  const defaultBranch = task.baseBranch || 'main';
  const branch = forgeBranchName(task.id);

  try {
    // One question: does the branch Forge assigned carry work? No candidate
    // list, no repo listing, no "anything ahead of base" — Forge named this
    // branch before the agent ran, so finding it is a lookup, not a search.
    const state = await checkForgeBranch(gh(), {
      owner,
      repo,
      baseBranch: defaultBranch,
      taskId: task.id,
    });
    if (!state.present) return false;

    // A PR may already exist for this branch (a re-run, or a retry that
    // pushed again) — record it rather than creating a duplicate.
    const { data: existingPrs } = await gh().pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: 'open',
    });
    if (existingPrs.length > 0) {
      const pr = existingPrs[0]!;
      const now = new Date();
      await db
        .update(tasks)
        .set({
          status: 'awaiting_ci',
          prUrl: pr.html_url,
          prNumber: pr.number,
          diffAdditions: state.aheadBy,
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      log.info({ taskId: task.id, prNumber: pr.number }, 'reconciler:existing_pr_found');
      return true;
    }

    // Derive PR title from the linked issue (if any) or the mission name
    let title = `Forge: ${mission.name}`;
    if (task.issueRef) {
      const issueNum = task.issueRef.split('#')[1];
      if (issueNum) {
        try {
          const { data: issue } = await gh().issues.get({
            owner,
            repo,
            issue_number: Number(issueNum),
          });
          title = issue.title;
        } catch {
          /* fall back to mission name */
        }
      }
    } else if (mission.name.startsWith('GH:')) {
      title = mission.name.replace(/^GH:\s*\S+\s*—\s*/, '');
    }

    const { data: pr } = await gh().pulls.create({
      owner,
      repo,
      title,
      body: `Automated by Forge.\n\nMission: ${mission.name}\nTask: ${task.id}\nBranch: ${branch}`,
      head: branch,
      base: defaultBranch,
    });

    const now = new Date();
    await db
      .update(tasks)
      .set({
        status: 'awaiting_ci',
        prUrl: pr.html_url,
        prNumber: pr.number,
        diffAdditions: state.filesChanged,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      taskId: task.id,
      eventType: 'gate.pr_opened',
      payload: {
        prNumber: pr.number,
        prUrl: pr.html_url,
        branch,
        aheadBy: state.aheadBy,
        openedBy: 'forge-reconciler',
      },
      createdAt: now,
    });

    log.info({ taskId: task.id, prNumber: pr.number, branch }, 'reconciler:pr_opened');
    return true;
  } catch (err) {
    log.info(
      { taskId: task.id, branch, err: err instanceof Error ? err.message : String(err) },
      'reconciler:pr_open_failed',
    );
    return false;
  }
}
```

- [ ] **Step 4: Update imports and delete the discovery module**

In `apps/web/src/server/tick/reconciler.ts`, replace:

```ts
import { branchIsTaskOwned, newestCommitDate } from './branch-ownership';
```

with:

```ts
import { forgeBranchName } from './branch-name';
import { checkForgeBranch } from './completion';
```

Then:

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
git rm apps/web/src/server/tick/branch-ownership.ts apps/web/src/server/tick/branch-ownership.test.ts
```

Confirm nothing else referenced it:

```bash
grep -rn "branch-ownership\|branchIsTaskOwned\|newestCommitDate" apps/web/src || echo "clean"
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts src/server/tick/reconciler.test.ts`
Expected: PASS.

Some existing tests seeded discovery scenarios (`listBranches` returning an agent-named branch, expecting adoption). Those assert behaviour this task deliberately removes. Update them to the new contract — the branch must be `forge/<taskId>` for a PR to open. **Do not weaken a test to make it pass**: if one asserts discovery is *intended*, stop and report it rather than editing it.

- [ ] **Step 6: Mutation-test, per behaviour**

1. Change `head: branch` in `pulls.create` to a literal `'main'` → **"opens the PR from the Forge-named branch"** must fail.
2. Change `if (!state.present) return false;` to `if (false) …` → **"never adopts a branch the agent named itself"** must fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add -A apps/web/src/server/tick
git commit -m "feat(reconciler): open the PR from the Forge-named branch; delete discovery"
```

---

## Task 5: The salvage push and the `no_commits` escalation

An agent may commit and fail to push, or push under the wrong name. Forge sends the exact command once per cycle, then escalates honestly.

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/web/src/server/tick/reconciler.ts`
- Modify: `apps/web/src/server/tick/reconciler-pr.test.ts`
- Modify: `docs/api/openapi.json` (regenerated)

**Interfaces:**
- Consumes: `forgeBranchName` (Task 1), `tryOpenPr` (Task 4)
- Produces: ledger event `push.requested`; escalation reason `no_commits`

- [ ] **Step 1: Add the escalation reason**

In `packages/db/src/schema.ts`, extend the `escalationReason` array:

```ts
  // The agent's turn ended, Forge asked it to push to the branch Forge
  // assigned, and still nothing is on the remote — so there is nothing to
  // open a pull request from. Distinct from stalled_no_branch, which
  // described the old inference; this states the fact.
  'no_commits',
```

- [ ] **Step 2: Write the failing tests**

In `apps/web/src/server/tick/reconciler-pr.test.ts`, add the adapter mock near the Octokit mock if it is not already present:

```ts
const mockAdapter = vi.hoisted(() => ({ sendTurn: vi.fn(async () => ({})) }));
vi.mock('./adapters', () => ({ getAdapter: () => mockAdapter }));
```

Then add:

```ts
  it('sends the exact push command when the branch is missing', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_live' });
    mockOctokit.repos.compareCommits.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await runReconciler(noopLog);

    // The agent is a shell for a command Forge wrote — no naming choice.
    const sent = mockAdapter.sendTurn.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain(`git push origin HEAD:forge/${taskId}`);
    const task = await getTask(taskId);
    expect(task?.status).toBe('turn_ended');
    const events = await getLedgerEvents(taskId);
    expect(events.some((e) => e.eventType === 'push.requested')).toBe(true);
  });

  it('does not re-send the push while one is already outstanding', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_live2' });
    await db.insert(schema.ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      missionId,
      taskId,
      eventType: 'push.requested',
      payload: { branch: `forge/${taskId}` },
      createdAt: new Date(),
    });
    mockOctokit.repos.compareCommits.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await runReconciler(noopLog);

    // One send per cycle, never per tick — same discipline as the CI retry
    // gate, which burned its whole budget in 90s before it was gated.
    expect(mockAdapter.sendTurn).not.toHaveBeenCalled();
    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('no_commits');
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts`
Expected: FAIL — no push is sent; the task abandons instead of escalating `no_commits`.

- [ ] **Step 4: Implement**

In `apps/web/src/server/tick/reconciler.ts`, inside the `turn_ended` sweep, replace the `else` branch that currently abandons (or nudges) a task with no PR. The continuation nudge (#51) stays as-is for the case where the agent has no commits at all; this adds the push step ahead of the abandon:

```ts
    // No pull request yet. Forge named the branch, so if it is missing the
    // agent either did not push or pushed elsewhere. Send the exact command
    // once per cycle; the agent is a shell for it, not a decision-maker.
    const branch = forgeBranchName(task.id);
    const [pushed] = await db
      .select({ n: sql<number>`count(*)` })
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.taskId, task.id), eq(ledgerEvents.eventType, 'push.requested')));
    const alreadyAsked = Number(pushed?.n ?? 0) > 0;

    if (!alreadyAsked && task.sessionId) {
      const now = new Date();
      // Claim before the side effect: sendTurn is not idempotent.
      const [claimed] = await db
        .update(tasks)
        .set({ updatedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')))
        .returning({ id: tasks.id });
      if (!claimed) continue;

      try {
        await getAdapter(mission.backend).sendTurn({
          sessionId: task.sessionId,
          text:
            `Your work is not on the remote yet. Run exactly this, then stop:\n\n` +
            `    git push origin HEAD:${branch}\n\n` +
            `Do not open a pull request — Forge opens it from that branch.`,
          backendSessionRef: task.backendSessionRef,
        });
      } catch (err) {
        log.info({ taskId: task.id, err }, 'reconciler:push_request_failed');
        // Session is gone; fall through to the abandon path below.
      }

      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'push.requested',
        payload: { branch },
        createdAt: now,
      });
      log.info({ taskId: task.id, branch }, 'reconciler:push_requested');
      continue; // stay turn_ended; next tick re-checks the branch
    }

    if (alreadyAsked) {
      // Asked and still nothing on the remote — the agent produced no commits.
      const now = new Date();
      const [claimed] = await db
        .update(tasks)
        .set({
          status: 'needs_human',
          escalationReason: 'no_commits',
          lastError: `no commits on ${branch} after a push was requested`,
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')))
        .returning({ id: tasks.id });
      if (!claimed) continue;

      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'gate.escalated',
        payload: { reason: 'no_commits', branch },
        createdAt: now,
      });
      tasksStalledEscalated += 1;
      log.info({ taskId: task.id }, 'reconciler:no_commits_escalated');
      continue;
    }
```

Ensure `getAdapter` and `sql` are imported in `reconciler.ts` (both are already used elsewhere in the file — verify rather than assume).

- [ ] **Step 5: Run the tests and regenerate the spec**

```bash
cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm api:spec
```

Expected: tests PASS; `docs/api/openapi.json` gains `no_commits`.

Confirm no migration was generated:

```bash
pnpm --filter @forge/db db:generate
```
Expected: `No schema changes, nothing to migrate`.

- [ ] **Step 6: Mutation-test, per behaviour**

1. Change the push text's `HEAD:${branch}` to `HEAD:main` → **"sends the exact push command when the branch is missing"** must fail.
2. Change `const alreadyAsked = …` to `const alreadyAsked = false;` → **"does not re-send the push while one is already outstanding"** must fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/reconciler.ts apps/web/src/server/tick/reconciler-pr.test.ts packages/db/src/schema.ts docs/api/openapi.json
git commit -m "feat(reconciler): dictate the salvage push, escalate no_commits"
```

---

## Task 6: Reclaim work pushed before a halt

A guardrail can halt an agent after it pushed. The reclaim sweep already exists (#62) but keys on discovery; point it at the Forge-named branch so it survives Task 4's deletion.

**Files:**
- Modify: `apps/web/src/server/tick/reconciler.ts` (the `strandedEscalations` sweep, ~line 307)
- Modify: `apps/web/src/server/tick/reconciler-pr.test.ts`

**Interfaces:**
- Consumes: `tryOpenPr` (Task 4, now exact-name)

- [ ] **Step 1: Write the failing test**

```ts
  it('reclaims work pushed before a guardrail halt', async () => {
    // The agent pushed to the Forge-named branch, then a guardrail halted it
    // before the turn ended. The work is on the remote; the escalation that
    // says otherwise is wrong on its face.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'stalled_no_branch',
      completedAt: new Date(),
    });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/11', number: 11 },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.escalationReason).toBeNull();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts`
Expected: FAIL if the sweep's status filter does not cover this case, or if it compares a discovered name.

- [ ] **Step 3: Widen the sweep's reasons**

In `apps/web/src/server/tick/reconciler.ts`, change the `strandedEscalations` query so it covers every stall reason a pushed branch can disprove:

```ts
  const strandedEscalations = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'needs_human'),
        inArray(tasks.escalationReason, ['stalled_no_branch', 'no_commits', 'ci_retry_stalled']),
        isNull(tasks.prUrl),
      ),
    );
```

The loop body is unchanged — it already calls `tryOpenPr`, which Task 4 made exact-name, and already clears the escalation and writes `gate.reclaimed`. Update its comment to say the check is now keyed on the Forge-named branch rather than provenance-gated discovery.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/reconciler-pr.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

Remove `'no_commits'` from the `inArray` list, seed a `no_commits` task with a present branch, and confirm it is not reclaimed → the reclaim test for that reason must fail. Restore.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/reconciler.ts apps/web/src/server/tick/reconciler-pr.test.ts
git commit -m "feat(reconciler): reclaim pushed work by Forge-named branch"
```

---

## Final verification

- [ ] `pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test` all clean
- [ ] `pnpm api:spec` produces no diff — the committed spec matches the enum
- [ ] `pnpm --filter @forge/db db:generate` reports `No schema changes, nothing to migrate`
- [ ] `grep -rn "branch-ownership\|branchIsTaskOwned\|listBranches" apps/web/src` returns nothing — discovery is gone
- [ ] `grep -rn "forge/" apps/web/src/server/tick --include=*.ts | grep -v branch-name.ts | grep -v test` shows no hand-built branch names; every one comes from `forgeBranchName`
- [ ] Every mutation listed in Tasks 2–6 was run, with the mutated source printed to confirm the edit landed, and reported per behaviour rather than bundled
