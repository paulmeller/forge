# Cohesive Product Phase B: Repo Operator Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/repos/[owner]/[repo]` from a plain issue list into the repo's operator console per the north-star reference: a header toolbar with real Deactivate/Manual/Refresh/GitHub controls, Issues/Activity/Settings tabs, per-issue attempt-history tabs (fixing a real grouping bug), PR chips, a file browser, and an Abort button — all backed by the container/leaf mission model Mission Hierarchy built.

**Architecture:** Backend first (schema, grouping fix, dispatcher enforcement, server actions), then UI (toolbar, tabs, reworked issue detail). Every new server action is a thin wrapper over existing primitives (`pauseMission`/`resumeMission`, `cancelSession`, `POST /tick`) — no new orchestration engine, just exposing what tick already does.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM + libSQL, Fastify (tick), vitest.

## Global Constraints

- "The standing mission" from earlier design docs is gone — say "the repo's container mission" (found via the existing `findWorkspaceMission(userId, repo)`, unchanged).
- Deactivate/Activate reuse the existing `pauseMission`/`resumeMission` from `apps/web/src/lib/mission-transitions.ts` verbatim — do not reimplement mission status transitions.
- Attempt-aware grouping (Task 2) is a **pure display/grouping fix** — it does not change how tasks are created (`workOnIssue`/`buildTriageTaskRows` are untouched). Every reproduce+fix pair `buildTriageTaskRows` creates for one issue is created in the same call, so pairing reproduce and fix tasks by ascending `createdAt` index (1st reproduce with 1st fix, 2nd with 2nd, …) is a safe, correct assumption — not a heuristic guess.
- The dispatcher's container-pause enforcement (Task 3) changes `computeContainerCaps`'s signature (adds a `containersById` parameter) and, as a side effect, fixes a latent bug: today, a leaf whose container isn't in the `status='running'` query (paused, or somehow missing) gets **no cap applied at all** (unconstrained), not zero slots. After this task, "container not running or missing" always means zero slots — genuinely safer, not just a new feature.
- No new sandbox/file-access plumbing for the file browser — it reuses the exact ledger/promptVars/verdict data `TaskFileTabs` (`apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/file-tabs.tsx`) already computes, just rendered as a table. `TaskFileTabs` itself is not modified.
- Spec: `docs/superpowers/specs/2026-07-16-cohesive-product-design.md` (Phase B section, reconciled with Mission Hierarchy).
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.

---

### Task 1: Schema — `nextIssueRefs` column + `manual_abort` halt reason

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: migration (generated, see Step 2)

**Interfaces:**
- Produces: `missions.nextIssueRefs: string[] | null` (JSON column), `haltReason` enum gains `'manual_abort'`.

- [ ] **Step 1: Add the column and enum value**

In `packages/db/src/schema.ts`, change:

```ts
export const haltReason = [
  'max_turns',
  'task_token_cap',
  'no_progress',
  'budget_hard_stop',
] as const;
```

to:

```ts
export const haltReason = [
  'max_turns',
  'task_token_cap',
  'no_progress',
  'budget_hard_stop',
  'manual_abort',
] as const;
```

In the `missions` table, add a new column right after `parentMissionId`, before `concurrencyCap`:

```ts
  /**
   * Issue refs ("owner/repo#123") a human has marked "Next" on this
   * repo's container — queued-for-work without dispatching. Cleared for
   * an issueRef the moment `workOnIssue` is called for it. Null/empty for
   * everything except containers actually in use.
   */
  nextIssueRefs: text('next_issue_refs', { mode: 'json' }).$type<string[]>(),
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:generate`

Keep only the statement adding `next_issue_refs` to `missions` (this repo's migration-snapshot chain has known gaps that sometimes emit spurious statements — see prior migrations' precedent). It should look like:

```sql
ALTER TABLE `missions` ADD `next_issue_refs` text;
```

The `halt_reason` column already exists as plain `text` (no CHECK constraint at the SQL level — the enum is TypeScript-only), so adding `'manual_abort'` to the TS array needs no migration of its own.

- [ ] **Step 3: Apply and verify**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:migrate`
Expected: `done`, no errors.

Run: `sqlite3 packages/db/local.db ".schema missions" | grep next_issue_refs`
Expected: one line showing the new column.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @forge/db typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/
git commit -m "feat(missions): nextIssueRefs column, manual_abort halt reason"
```

---

### Task 2: Attempt-aware issue grouping (TDD) — fixes the real overwrite bug

**Files:**
- Modify: `apps/web/src/lib/triage-view.ts`
- Modify: `apps/web/src/lib/triage-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Attempt = {
    index: number; // 1-based, oldest = 1
    reproduce: Task | null;
    fix: Task | null;
    headline: TriageHeadline;
  };
  export type IssueGroup = {
    issueRef: string;
    repo: string;
    issueNumber: number | null;
    title: string;
    url: string | null;
    attempts: Attempt[]; // oldest -> newest, at least one entry once any task exists
    headline: TriageHeadline; // = attempts.at(-1).headline — for row badges / WorkOnItButton
  };
  ```
  (`headlineFor` is unchanged — still `(reproduce: Task | null, fix: Task | null) => TriageHeadline`.)
- Consumes: nothing new.

- [ ] **Step 1: Read the current file and existing tests**

Read `apps/web/src/lib/triage-view.ts` and `apps/web/src/lib/triage-view.test.ts` in full before editing — this task changes `IssueGroup`'s shape (`reproduce`/`fix` top-level fields become `attempts`), so every existing test asserting `group.reproduce`/`group.fix` directly needs updating to `group.attempts.at(-1)`. Do not skip reading the existing test file; there are 11 existing tests that must still pass in spirit even though their assertions change shape.

- [ ] **Step 2: Write the new/updated tests**

In `apps/web/src/lib/triage-view.test.ts`, add this regression test (the actual bug this task fixes) alongside the existing tests, adjusting existing assertions from `group.reproduce`/`group.fix` to `group.attempts.at(-1)?.reproduce`/`group.attempts.at(-1)?.fix` wherever they appear (read the current file to find each one — do not guess line numbers, the exact existing test bodies must be preserved with only the field-path changed):

```ts
it('groups multiple attempts on the same issue into separate attempt entries, oldest first (regression: previously the second attempt silently overwrote the first)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const later = new Date('2026-01-02T00:00:00.000Z');

  const reproduce1 = task('tsk_rep1', {
    issueRef: 'acme/api#1',
    kind: 'reproduce',
    status: 'resolved',
    verdict: { reproduced: false, summary: 'could not reproduce on attempt 1' },
    createdAt: now,
  });
  const reproduce2 = task('tsk_rep2', {
    issueRef: 'acme/api#1',
    kind: 'reproduce',
    status: 'running',
    createdAt: later,
  });

  const groups = groupTasksByIssue([reproduce1, reproduce2]);

  expect(groups).toHaveLength(1);
  const group = groups[0]!;
  expect(group.attempts).toHaveLength(2);
  expect(group.attempts[0]!.index).toBe(1);
  expect(group.attempts[0]!.reproduce).toBe(reproduce1);
  expect(group.attempts[0]!.fix).toBeNull();
  expect(group.attempts[1]!.index).toBe(2);
  expect(group.attempts[1]!.reproduce).toBe(reproduce2);
  expect(group.attempts[1]!.fix).toBeNull();
  // The row-level headline reflects the NEWEST attempt (still reproducing).
  expect(group.headline).toBe('reproducing');
});

it('pairs reproduce and fix tasks into the same attempt by creation order, not by task id', () => {
  const t1 = new Date('2026-01-01T00:00:00.000Z');
  const t2 = new Date('2026-01-02T00:00:00.000Z');

  const reproduce1 = task('tsk_rep1', {
    issueRef: 'acme/api#2',
    kind: 'reproduce',
    status: 'resolved',
    verdict: { reproduced: true, summary: 'reproduced on attempt 1' },
    createdAt: t1,
  });
  const fix1 = task('tsk_fix1', {
    issueRef: 'acme/api#2',
    kind: 'fix',
    status: 'merged',
    createdAt: t1,
  });
  const reproduce2 = task('tsk_rep2', {
    issueRef: 'acme/api#2',
    kind: 'reproduce',
    status: 'resolved',
    verdict: { reproduced: true, summary: 'reproduced on attempt 2' },
    createdAt: t2,
  });
  const fix2 = task('tsk_fix2', {
    issueRef: 'acme/api#2',
    kind: 'fix',
    status: 'awaiting_review',
    createdAt: t2,
  });

  // Deliberately out of chronological order in the input array — pairing must
  // key off createdAt, not array position.
  const groups = groupTasksByIssue([fix2, reproduce1, fix1, reproduce2]);

  expect(groups).toHaveLength(1);
  const group = groups[0]!;
  expect(group.attempts).toHaveLength(2);
  expect(group.attempts[0]!.reproduce).toBe(reproduce1);
  expect(group.attempts[0]!.fix).toBe(fix1);
  expect(group.attempts[1]!.reproduce).toBe(reproduce2);
  expect(group.attempts[1]!.fix).toBe(fix2);
  expect(group.headline).toBe('fix_review');
});

it('does not confuse attempts across two different issues in the same task list', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const r1 = task('tsk_r1', { issueRef: 'acme/api#1', kind: 'reproduce', createdAt: now });
  const r2 = task('tsk_r2', { issueRef: 'acme/api#2', kind: 'reproduce', createdAt: now });

  const groups = groupTasksByIssue([r1, r2]);

  expect(groups).toHaveLength(2);
  const g1 = groups.find((g) => g.issueRef === 'acme/api#1')!;
  const g2 = groups.find((g) => g.issueRef === 'acme/api#2')!;
  expect(g1.attempts).toHaveLength(1);
  expect(g1.attempts[0]!.reproduce).toBe(r1);
  expect(g2.attempts).toHaveLength(1);
  expect(g2.attempts[0]!.reproduce).toBe(r2);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- triage-view`
Expected: FAIL — `attempts` doesn't exist on the current `IssueGroup` shape, and the existing tests you updated to read `group.attempts.at(-1)` fail against the old flat implementation.

- [ ] **Step 4: Rewrite the implementation**

In `apps/web/src/lib/triage-view.ts`, replace the `IssueGroup` type and `groupTasksByIssue`:

```ts
export type Attempt = {
  index: number;
  reproduce: Task | null;
  fix: Task | null;
  headline: TriageHeadline;
};

export type IssueGroup = {
  issueRef: string;
  repo: string;
  issueNumber: number | null;
  title: string;
  url: string | null;
  attempts: Attempt[];
  /** Coarse headline state for the row badge / sort order — the newest attempt's. */
  headline: TriageHeadline;
};
```

(Leave `TriageHeadline`, `HEADLINE_ORDER`, `promptVar`, and `headlineFor` exactly as they are — only `IssueGroup` and `groupTasksByIssue` change.)

Replace `groupTasksByIssue`:

```ts
/**
 * Group a Mission's Tasks into per-issue triage rows, attempt-aware: each
 * "Work again" appends a new reproduce+fix task pair to the SAME issue
 * mission (see Mission Hierarchy's getOrCreateIssueMission), and every pair
 * from one buildTriageTaskRows call shares essentially the same createdAt —
 * so pairing reproduce/fix tasks by ascending createdAt index (1st with
 * 1st, 2nd with 2nd, …) correctly reconstructs attempt history. Non-triage
 * Tasks (no issueRef) are ignored. Pure — exported for testing.
 */
export function groupTasksByIssue(tasks: Task[]): IssueGroup[] {
  const byRef = new Map<string, Task[]>();

  for (const task of tasks) {
    if (!task.issueRef) continue;
    if (task.kind !== 'reproduce' && task.kind !== 'fix') continue;
    const list = byRef.get(task.issueRef) ?? [];
    list.push(task);
    byRef.set(task.issueRef, list);
  }

  const groups: IssueGroup[] = [];
  for (const [issueRef, issueTasks] of byRef) {
    const reproduces = issueTasks
      .filter((t) => t.kind === 'reproduce')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const fixes = issueTasks
      .filter((t) => t.kind === 'fix')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const attemptCount = Math.max(reproduces.length, fixes.length);

    const attempts: Attempt[] = [];
    for (let i = 0; i < attemptCount; i++) {
      const reproduce = reproduces[i] ?? null;
      const fix = fixes[i] ?? null;
      attempts.push({ index: i + 1, reproduce, fix, headline: headlineFor(reproduce, fix) });
    }

    const anyTask = issueTasks[0] ?? null;
    const numRaw = promptVar(anyTask, 'issue_number');
    const issueNumber =
      typeof numRaw === 'number' ? numRaw : parseIssueNumber(issueRef);
    const titleRaw = promptVar(anyTask, 'issue_title');
    const urlRaw = promptVar(anyTask, 'issue_url');

    groups.push({
      issueRef,
      repo: anyTask?.repo ?? issueRef.split('#')[0] ?? '',
      issueNumber,
      title: typeof titleRaw === 'string' && titleRaw ? titleRaw : issueRef,
      url: typeof urlRaw === 'string' ? urlRaw : null,
      attempts,
      headline: attempts.at(-1)?.headline ?? 'reproducing',
    });
  }

  groups.sort(
    (a, b) => HEADLINE_ORDER.indexOf(a.headline) - HEADLINE_ORDER.indexOf(b.headline),
  );
  return groups;
}
```

Note: the old implementation read `promptVar(reproduce ?? fix, key)` (the single pair's tasks) for issue metadata; the new one reads `promptVar(anyTask, key)` (the first task found for that issueRef, regardless of attempt) — every task for the same issue carries the same `issue_number`/`issue_title`/`issue_url` in its `promptVars` (they're derived from the same GitHub issue each time `buildTriageTaskRows` runs), so this is equivalent, not a behavior change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- triage-view`
Expected: PASS (existing tests updated to the new shape, plus the 3 new attempt-history tests).

- [ ] **Step 6: Fix downstream compile breakage with a minimal shim (Task 11 replaces this properly)**

`issue-run-panel.tsx` and `page.tsx` read `group.reproduce`/`group.fix` directly, which no longer exist on `IssueGroup` after Step 4 — this task's commit must not leave the repo typecheck-broken (a hard rule in this plan, learned the expensive way during Mission Hierarchy Phase 2). Apply a minimal compatibility shim now; Task 11 (later in this plan) replaces `issue-run-panel.tsx` properly with real attempt tabs.

In `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`, change the two reads:

```ts
  const task = stage === 'reproduce' ? group.reproduce : group.fix;
```
```ts
  const verdict = group.reproduce?.verdict ?? null;
```

to:

```ts
  const latest = group.attempts.at(-1) ?? null;
  const task = stage === 'reproduce' ? (latest?.reproduce ?? null) : (latest?.fix ?? null);
```
```ts
  const verdict = latest?.reproduce?.verdict ?? null;
```

(This keeps showing only the latest attempt for now — a mechanical fix to stay green, not a redesign.)

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, find the ledger-fetching loop (`row.group?.reproduce?.id, row.group?.fix?.id`) and change it to:

```ts
      const ids = [
        row.group?.attempts.at(-1)?.reproduce?.id,
        row.group?.attempts.at(-1)?.fix?.id,
      ].filter((id): id is string => !!id);
```

`workspace-list.tsx`'s own reference (`selected.group.headline`) needs no change — `headline` still exists at the top level of `IssueGroup`.

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 7: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/triage-view.ts apps/web/src/lib/triage-view.test.ts "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "fix(triage): attempt-aware issue grouping — Work again no longer overwrites earlier attempts"
```

---

### Task 3: Dispatcher — real container-pause enforcement (TDD)

**Files:**
- Modify: `apps/tick/src/dispatcher.ts`
- Modify: `apps/tick/src/dispatcher.test.ts`

**Interfaces:**
- Produces (signature change):
  ```ts
  export function computeContainerCaps(
    runningMissions: Mission[],
    containersById: Map<string, Mission>,
    siblingInflightByParentId: Map<string, number>,
  ): Map<string, number>;
  ```

- [ ] **Step 1: Update the existing tests for the new signature**

In `apps/tick/src/dispatcher.test.ts`, find the `describe('computeContainerCaps', ...)` block. Replace it in full:

```ts
describe('computeContainerCaps', () => {
  it('returns no cap for missions without a parent', () => {
    const campaign = mission({ id: 'msn_campaign' });
    const caps = computeContainerCaps([campaign], new Map(), new Map());
    expect(caps.has('msn_campaign')).toBe(false);
  });

  it('caps a leaf mission by its running container concurrencyCap minus sibling inflight', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 3, status: 'running' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([container, leaf], containersById, new Map([['msn_container', 2]]));
    expect(caps.get('msn_leaf')).toBe(1);
  });

  it('floors at zero when sibling inflight already meets or exceeds the container cap', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 2, status: 'running' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([container, leaf], containersById, new Map([['msn_container', 5]]));
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('blocks all claiming (cap 0) when the leaf container is paused — Deactivate has real teeth', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 5, status: 'paused' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([leaf], containersById, new Map());
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('blocks all claiming (cap 0), not unconstrained, when the parent container is missing entirely', () => {
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_missing_container' });
    const caps = computeContainerCaps([leaf], new Map(), new Map());
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('gives every sibling under the same running container the same remaining-slots ceiling', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 4, status: 'running' });
    const leafA = mission({ id: 'msn_leaf_a', parentMissionId: 'msn_container' });
    const leafB = mission({ id: 'msn_leaf_b', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps(
      [container, leafA, leafB],
      containersById,
      new Map([['msn_container', 1]]),
    );
    expect(caps.get('msn_leaf_a')).toBe(3);
    expect(caps.get('msn_leaf_b')).toBe(3);
  });
});
```

Note the 4th test's behavior deliberately changed from the pre-existing test (`caps.has('msn_leaf')` was `false`; now `caps.get('msn_leaf')` is `0`) — this is the correctness fix described in this plan's Global Constraints, not a mistake to reconcile.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/tick test -- dispatcher`
Expected: FAIL — `computeContainerCaps` still takes 2 arguments, not 3.

- [ ] **Step 3: Update the implementation**

In `apps/tick/src/dispatcher.ts`, replace `computeContainerCaps`:

```ts
export function computeContainerCaps(
  runningMissions: Mission[],
  containersById: Map<string, Mission>,
  siblingInflightByParentId: Map<string, number>,
): Map<string, number> {
  const caps = new Map<string, number>();
  for (const mission of runningMissions) {
    if (!mission.parentMissionId) continue;
    const container = containersById.get(mission.parentMissionId);
    if (!container || container.status !== 'running') {
      caps.set(mission.id, 0);
      continue;
    }
    const inflight = siblingInflightByParentId.get(mission.parentMissionId) ?? 0;
    caps.set(mission.id, Math.max(0, container.concurrencyCap - inflight));
  }
  return caps;
}
```

Update its doc comment too — replace the existing comment block above it with:

```ts
/**
 * For every currently-running mission that has a parent (an issue leaf
 * nested under a repo's container), computes how many of that container's
 * slots remain this tick. A leaf whose container is paused (Deactivate) or
 * doesn't exist gets zero slots — blocked, not unconstrained. Otherwise:
 * container concurrencyCap minus tasks already inflight across ALL its
 * children (siblings).
 *
 * Pure given its inputs — the caller (runDispatcher) queries the live
 * container rows and sibling-inflight counts once per tick and passes them
 * in. This is a per-tick snapshot, not perfectly atomic across siblings
 * claimed within the same tick — two siblings under a busy container could
 * each be handed the same remaining-slots ceiling and jointly claim
 * slightly over cap in one tick; the next tick's fresh snapshot
 * self-corrects. Exported for testing.
 */
```

Update `runDispatcher` to fetch containers by id directly (not filtered to `status='running'`, since a paused container must still be found and checked):

```ts
export async function runDispatcher(log: {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}): Promise<DispatchResult> {
  const runningMissions = await db.select().from(missions).where(eq(missions.status, 'running'));

  const parentIds = Array.from(
    new Set(runningMissions.map((m) => m.parentMissionId).filter((id): id is string => !!id)),
  );
  let containersById = new Map<string, Mission>();
  if (parentIds.length > 0) {
    const containerRows = await db.select().from(missions).where(inArray(missions.id, parentIds));
    containersById = new Map(containerRows.map((c) => [c.id, c]));
  }

  let siblingInflightByParentId = new Map<string, number>();
  if (parentIds.length > 0) {
    const rows = await db
      .select({ parentMissionId: missions.parentMissionId, count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(inArray(missions.parentMissionId, parentIds), inArray(tasks.status, INFLIGHT_STATUSES)),
      )
      .groupBy(missions.parentMissionId);
    siblingInflightByParentId = new Map(
      rows
        .filter((r): r is typeof r & { parentMissionId: string } => !!r.parentMissionId)
        .map((r) => [r.parentMissionId, Number(r.count)]),
    );
  }
  const containerCaps = computeContainerCaps(runningMissions, containersById, siblingInflightByParentId);

  let totalClaimed = 0;
  let totalDispatched = 0;
  let totalFailed = 0;

  for (const mission of runningMissions) {
    const claimed = await claimNextBatch(mission, containerCaps.get(mission.id));
    totalClaimed += claimed.length;
    if (claimed.length === 0) continue;

    for (const task of claimed) {
      try {
        await dispatchOne(mission, task);
        totalDispatched += 1;
      } catch (err) {
        totalFailed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ taskId: task.id, err: message }, 'dispatch:failed');
        await markFailed(task.id, message);
      }
    }
  }

  return {
    missions: runningMissions.length,
    claimed: totalClaimed,
    dispatched: totalDispatched,
    failed: totalFailed,
  };
}
```

(Only the container-fetching block and the `computeContainerCaps` call changed — the claim/dispatch loop after it is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/tick test -- dispatcher`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/tick typecheck`
Expected: clean.

- [ ] **Step 6: Run the full tick test suite**

Run: `pnpm --filter @forge/tick test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add apps/tick/src/dispatcher.ts apps/tick/src/dispatcher.test.ts
git commit -m "feat(dispatcher): a paused container blocks its issue leaves from claiming — Deactivate now has real teeth"
```

---

### Task 4: `abortTask` server action

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Produces:
  ```ts
  export function abortTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Add the action**

Read the current full content of `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts` first (it has `workOnIssue` and `createIssue`).

**Note:** `apps/tick/src/adapters/index.ts`'s `getAdapter` lives in the `@forge/tick` package, which `apps/web` does not depend on and must not start depending on — tick and web are deployed as separate services. `cancelSession` needs to be called from the web side against the same managed-agents backend tick uses, which means a small local helper here, not importing tick's adapter module. `@anthropic-ai/sdk` is already a dependency of `apps/web` (used elsewhere, e.g. the chat route).

Verified against `apps/tick/src/adapters/managed-agents.ts:122-126` — `cancelSession` does **not** call any `sessions.cancel` method (no such method exists); it sends a `user.interrupt` event on the session's event stream:

```ts
async cancelSession(sessionId: string): Promise<void> {
  await this.client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.interrupt' }],
  } as never);
}
```

Add this import to `actions.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
```

Add this function and the server action after `createIssue`, matching the verified call above exactly:

```ts
async function cancelManagedAgentsSession(sessionId: string): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.interrupt' }],
  } as never);
}

/**
 * Abort a running Task's session. Only meaningful for a Task with an active
 * session (running/dispatching/etc.) — marks it failed with haltReason
 * 'manual_abort', mirroring the shape budgets.ts's hardStop already uses for
 * the same kind of forced stop.
 */
export async function abortTask(
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { ok: false, error: 'Task not found' };
  if (!task.sessionId) return { ok: false, error: 'Task has no active session to abort' };

  try {
    await cancelManagedAgentsSession(task.sessionId);
  } catch (err) {
    return {
      ok: false,
      error: `Could not cancel session: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  const now = new Date();
  await db
    .update(tasks)
    .set({
      status: 'failed',
      haltReason: 'manual_abort',
      lastError: 'Aborted by operator',
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(tasks.id, taskId));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'task.aborted',
    payload: { sessionId: task.sessionId },
    createdAt: now,
  });

  return { ok: true };
}
```

This requires `env` imported from `@/lib/env` (check whether it's already imported in this file; if not, add `import { env } from '@/lib/env';`) and `eq` from `drizzle-orm` (check the existing import line — this file likely already imports from `drizzle-orm` for other queries; extend that import rather than adding a duplicate).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass (no dedicated test file for this action — matches this project's convention of not unit-testing server actions that make live network calls).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): abortTask server action — cancels the session, marks the task manually aborted"
```

---

### Task 5: Repo-level actions — Deactivate/Activate + Manual tick trigger

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Produces:
  ```ts
  export function deactivateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }>;
  export function activateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }>;
  export function triggerManualTick(): Promise<{ ok: true } | { ok: false; error: string }>;
  ```
- Consumes: `pauseMission`/`resumeMission` (`@/lib/mission-transitions`, existing), `findWorkspaceMission` (`@/lib/workspace-mission`, existing), `env.TICK_INTERNAL_URL` (`@/lib/env`, existing).

- [ ] **Step 1: Add the three actions**

Add these imports to `actions.ts`:

```ts
import { pauseMission, resumeMission } from '@/lib/mission-transitions';
import { findWorkspaceMission } from '@/lib/workspace-mission';
```

(`findWorkspaceMission` may already be imported elsewhere in this file's neighborhood — check `page.tsx`'s import, not `actions.ts`'s; if `actions.ts` doesn't import it yet, add it fresh.)

Append:

```ts
/** Pause the repo's container mission — the dispatcher will stop claiming any of its issue leaves' tasks (Task 3 of this plan). */
export async function deactivateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const container = await findWorkspaceMission(user.id, repo);
  if (!container) return { ok: false, error: 'No activity yet for this repo' };
  try {
    await pauseMission(container.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not deactivate' };
  }
}

/** Resume the repo's container mission. */
export async function activateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const container = await findWorkspaceMission(user.id, repo);
  if (!container) return { ok: false, error: 'No activity yet for this repo' };
  try {
    await resumeMission(container.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not activate' };
  }
}

/** Trigger a tick right now instead of waiting for the next scheduled one. */
export async function triggerManualTick(): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();
  try {
    const res = await fetch(`${env.TICK_INTERNAL_URL}/tick`, { method: 'POST' });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `tick returned ${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach tick: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): deactivateRepo/activateRepo/triggerManualTick server actions"
```

---

### Task 6: Next marker — toggle action + consumption in workOnIssue

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`
- Create: `apps/web/src/lib/next-marker.test.ts` (or inline test in actions — see Step 1 note)

**Interfaces:**
- Produces:
  ```ts
  export function toggleNextMarker(repo: string, issueRef: string, marked: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  ```
- Modifies: `workOnIssue` to clear `issueRef` from the container's `nextIssueRefs` when called.

- [ ] **Step 1: Write a pure helper and its test first**

The array add/remove logic is pure enough to unit test in isolation before wiring it into a DB-touching action. Create `apps/web/src/lib/next-marker.ts`:

```ts
/** Add or remove one issueRef from a container's nextIssueRefs list, deduplicated. */
export function updateNextIssueRefs(
  current: string[] | null,
  issueRef: string,
  marked: boolean,
): string[] {
  const set = new Set(current ?? []);
  if (marked) set.add(issueRef);
  else set.delete(issueRef);
  return [...set];
}
```

Create `apps/web/src/lib/next-marker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { updateNextIssueRefs } from './next-marker';

describe('updateNextIssueRefs', () => {
  it('adds an issueRef to an empty/null list', () => {
    expect(updateNextIssueRefs(null, 'acme/api#1', true)).toEqual(['acme/api#1']);
    expect(updateNextIssueRefs([], 'acme/api#1', true)).toEqual(['acme/api#1']);
  });

  it('is a no-op when adding an issueRef already present', () => {
    expect(updateNextIssueRefs(['acme/api#1'], 'acme/api#1', true)).toEqual(['acme/api#1']);
  });

  it('removes an issueRef when unmarking', () => {
    expect(updateNextIssueRefs(['acme/api#1', 'acme/api#2'], 'acme/api#1', false)).toEqual([
      'acme/api#2',
    ]);
  });

  it('is a no-op when unmarking an issueRef not present', () => {
    expect(updateNextIssueRefs(['acme/api#2'], 'acme/api#1', false)).toEqual(['acme/api#2']);
  });

  it('preserves other entries when adding alongside existing ones', () => {
    expect(updateNextIssueRefs(['acme/api#2'], 'acme/api#1', true).sort()).toEqual(
      ['acme/api#1', 'acme/api#2'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `pnpm --filter @forge/web test -- next-marker`
Expected: FAIL (module doesn't exist) — write the implementation above, then re-run.
Expected after implementing: PASS (5 tests).

- [ ] **Step 3: Add `toggleNextMarker` and wire clearing into `workOnIssue`**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`, add the import:

```ts
import { updateNextIssueRefs } from '@/lib/next-marker';
```

Append this action:

```ts
/** Mark or unmark an issue as "Next" on this repo — queued for work without dispatching. */
export async function toggleNextMarker(
  repo: string,
  issueRef: string,
  marked: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const defaults = await resolveMissionDefaults(user.id);

  let container;
  try {
    container = await getOrCreateWorkspaceMission(user.id, repo, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare container' };
  }

  const next = updateNextIssueRefs(container.nextIssueRefs, issueRef, marked);
  await db.update(missions).set({ nextIssueRefs: next, updatedAt: new Date() }).where(eq(missions.id, container.id));

  return { ok: true };
}
```

(This requires `getOrCreateWorkspaceMission` imported from `@/lib/workspace-mission` — check whether `workOnIssue` already imports it under a different name (it currently imports `getOrCreateIssueMission`, not `getOrCreateWorkspaceMission` directly, per Mission Hierarchy Phase 1) and add `getOrCreateWorkspaceMission` alongside it. Also requires `missions` imported from `@forge/db` — check the existing `@forge/db` import line in this file and extend it rather than duplicating.)

Now wire the clearing into `workOnIssue`. Find its existing body (it currently computes `issueRef` near the top and calls `getOrCreateIssueMission`). Immediately after the transaction that inserts tasks + the `workspace.issue.enqueued` ledger event succeeds, add the clear-next-marker step. The exact insertion point: right after the `await db.transaction(...)` block in `workOnIssue`, before its final `return { ok: true };`, add:

```ts
  // Working an issue consumes its "Next" mark, if any.
  try {
    const container = await getOrCreateWorkspaceMission(user.id, repo, defaults);
    if (container.nextIssueRefs?.includes(issueRef)) {
      const next = updateNextIssueRefs(container.nextIssueRefs, issueRef, false);
      await db.update(missions).set({ nextIssueRefs: next, updatedAt: new Date() }).where(eq(missions.id, container.id));
    }
  } catch {
    // Non-fatal — the issue was successfully worked either way; a stale
    // Next mark is cosmetic and will be cleared next time this runs.
  }
```

(`defaults` is already in scope in `workOnIssue` from its earlier `resolveMissionDefaults` call — reuse it, don't refetch.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/next-marker.ts apps/web/src/lib/next-marker.test.ts "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): Next marker on issues, cleared automatically when Work on it is used"
```

---

### Task 7: Repo Workspace header toolbar — Deactivate/Activate, Manual, Refresh, GitHub

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Consumes: `deactivateRepo`, `activateRepo`, `triggerManualTick` (Task 5).
- Produces: `RepoToolbar({ repo, owner, repoName, containerStatus }: { repo: string; owner: string; repoName: string; containerStatus: 'running' | 'paused' | null })`.

- [ ] **Step 1: Create the toolbar component**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

import { activateRepo, deactivateRepo, triggerManualTick } from './actions';

export function RepoToolbar({
  repo,
  containerStatus,
}: {
  repo: string;
  containerStatus: 'running' | 'paused' | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggleActive() {
    setError(null);
    startTransition(async () => {
      const result =
        containerStatus === 'paused' ? await activateRepo(repo) : await deactivateRepo(repo);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleManualTick() {
    setError(null);
    startTransition(async () => {
      const result = await triggerManualTick();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex shrink-0 items-center gap-2">
        {containerStatus ? (
          <Button variant="outline" size="sm" onClick={handleToggleActive} disabled={pending}>
            {containerStatus === 'paused' ? 'Activate' : 'Deactivate'}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={handleManualTick} disabled={pending}>
          Manual
        </Button>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          Refresh
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
            GitHub ↗
          </Link>
        </Button>
        <Button asChild variant="accent" size="sm">
          <Link href={`/missions/new?repo=${encodeURIComponent(repo)}`}>Run a goal on this repo →</Link>
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the page header, replacing the old "View missions" button placement**

Read the current full content of `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx` before editing (it currently has `NewIssueDialog` and a "View missions" button in the header, plus a `mission` variable from `findWorkspaceMission`).

Add the import:

```ts
import { RepoToolbar } from './repo-toolbar';
```

Replace the header's button row:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          <NewIssueDialog owner={owner} repo={repoName} />
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions?repo=${encodeURIComponent(repo)}`}>View missions</Link>
            </Button>
          ) : null}
        </div>
```

with:

```tsx
        <div className="flex shrink-0 items-start gap-2">
          <NewIssueDialog owner={owner} repo={repoName} />
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions?repo=${encodeURIComponent(repo)}`}>View missions</Link>
            </Button>
          ) : null}
          <RepoToolbar
            repo={repo}
            containerStatus={
              mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
            }
          />
        </div>
```

(`mission` here is the container, from the existing `findWorkspaceMission` call already at the top of this component — reuse it, don't refetch. Its `status` is one of the full `MissionStatus` enum; this narrows to just `'paused' | 'running'` for the toolbar's purposes, treating any other status — `draft`, `planning`, `completed`, `cancelled` — as `'running'` for button-label purposes, since a container in practice is only ever `running` or `paused` per `getOrCreateWorkspaceMission`'s creation code and `pauseMission`/`resumeMission`'s transitions.)

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/paulmeller/forge`
Expected: `307` or `200`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): repo toolbar — Deactivate/Activate, Manual, Refresh, GitHub"
```

---

### Task 8: Tabs shell + Activity tab

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx`
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/activity-tab.tsx`
- Create: `apps/web/src/lib/repo-activity.ts`
- Create: `apps/web/src/lib/repo-activity.test.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function listTasksTouchingRepo(userId: string, repo: string): Promise<Array<{ task: Task; missionId: string; missionName: string; isIssueMission: boolean }>>;
  export function RepoTabs({ active, repo }: { active: 'issues' | 'activity' | 'settings'; repo: string }): JSX.Element;
  export function ActivityTab({ rows }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test for the Activity query**

Create `apps/web/src/lib/repo-activity.test.ts`, following the real-throwaway-database pattern already used in `apps/web/src/lib/missions.test.ts` and `apps/web/src/lib/tasks.test.ts` (read one of those files first for the exact boilerplate — DB_FILE setup, `insertMission`/`insertTask` helpers, migrate call):

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-repo-activity-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listTasksTouchingRepo: typeof import('./repo-activity').listTasksTouchingRepo;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listTasksTouchingRepo } = await import('./repo-activity'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertMission(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertTask(id: string, missionId: string, repo: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo,
    baseBranch: 'main',
    kind: 'standard',
    status: 'merged',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('listTasksTouchingRepo', () => {
  it('returns tasks from both a campaign mission and an issue leaf mission for the same repo, but not tasks for a different repo', async () => {
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(campaignId, { workspaceRepo: null, targetRepos: ['acme/api'] });
    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(leafId, { workspaceRepo: 'acme/api', issueRef: 'acme/api#1', parentMissionId: containerId });

    await insertTask('tsk_campaign', campaignId, 'acme/api');
    await insertTask('tsk_issue', leafId, 'acme/api', { kind: 'fix', issueRef: 'acme/api#1' });
    await insertTask('tsk_other_repo', campaignId, 'acme/web');

    const rows = await listTasksTouchingRepo('user_1', 'acme/api');
    const ids = rows.map((r) => r.task.id);

    expect(ids).toContain('tsk_campaign');
    expect(ids).toContain('tsk_issue');
    expect(ids).not.toContain('tsk_other_repo');

    const campaignRow = rows.find((r) => r.task.id === 'tsk_campaign')!;
    const issueRow = rows.find((r) => r.task.id === 'tsk_issue')!;
    expect(campaignRow.isIssueMission).toBe(false);
    expect(issueRow.isIssueMission).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @forge/web test -- repo-activity`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `listTasksTouchingRepo`**

Create `apps/web/src/lib/repo-activity.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';

import { missions, tasks, type Task } from '@forge/db';

import { db } from './db';
import { isIssueMission } from './mission-shape';

export type RepoActivityRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isIssueMission: boolean;
};

/**
 * Every Task that has touched this repo from either mode — campaign tasks
 * (via `tasks.repo`) and issue-leaf tasks alike. This is the Activity tab's
 * data source: where the two modes visibly meet on one repo's timeline.
 */
export async function listTasksTouchingRepo(userId: string, repo: string): Promise<RepoActivityRow[]> {
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      issueRef: missions.issueRef,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), eq(tasks.repo, repo)))
    .orderBy(desc(tasks.updatedAt));

  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isIssueMission: isIssueMission({ issueRef: r.issueRef }),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @forge/web test -- repo-activity`
Expected: PASS.

- [ ] **Step 5: Create the tabs shell**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx`:

```tsx
'use client';

import Link from 'next/link';

const TABS = [
  { key: 'issues', label: 'Issues' },
  { key: 'activity', label: 'Activity' },
  { key: 'settings', label: 'Settings' },
] as const;

export function RepoTabs({
  active,
  repo,
}: {
  active: 'issues' | 'activity' | 'settings';
  repo: string;
}) {
  return (
    <div className="mb-4 flex gap-1 border-b">
      {TABS.map((tab) => {
        const href =
          tab.key === 'issues' ? `/repos/${repo}` : `/repos/${repo}?tab=${tab.key}`;
        return (
          <Link
            key={tab.key}
            href={href}
            className={`px-3 py-2 text-sm font-medium ${
              active === tab.key
                ? 'border-b-2 border-[color:var(--forge-accent-to)] text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Create the Activity tab component**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/activity-tab.tsx`:

```tsx
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { RepoActivityRow } from '@/lib/repo-activity';

export function ActivityTab({ rows }: { rows: RepoActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        No Tasks have touched this repo yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <Link
          key={row.task.id}
          href={`/missions/${row.missionId}/tasks/${row.task.id}`}
          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{row.task.issueRef ?? row.missionName}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{row.task.kind}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {row.isIssueMission ? (
              <Badge variant="outline" className="text-[10px]">
                Issue
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Campaign
              </Badge>
            )}
            <TaskStatusBadge status={row.task.status} haltReason={row.task.haltReason} />
          </div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Wire the tabs and Activity data into the page**

Read the current full content of `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx` before editing. Add imports:

```ts
import { ActivityTab } from './activity-tab';
import { RepoTabs } from './repo-tabs';
import { listTasksTouchingRepo } from '@/lib/repo-activity';
```

Update the page's props to read the `tab` search param:

```tsx
export default async function RepoWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; repo: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { owner, repo: repoName } = await params;
  const { tab } = await searchParams;
  const activeTab = tab === 'activity' ? 'activity' : tab === 'settings' ? 'settings' : 'issues';
  const repo = `${owner}/${repoName}`;
  const user = await withAuth();
```

After the existing header block (the one with `NewIssueDialog`/`RepoToolbar`), insert the tabs and branch on `activeTab`. The existing `<WorkspaceList .../>` render at the bottom of the component becomes the `'issues'` branch; wrap it:

```tsx
      <RepoTabs active={activeTab} repo={repo} />

      {activeTab === 'activity' ? (
        <ActivityTab rows={await listTasksTouchingRepo(user.id, repo)} />
      ) : activeTab === 'settings' ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Settings tab — see Task 9 of this plan.
        </div>
      ) : (
        <WorkspaceList
          repo={repo}
          rows={rows}
          missionId={mission?.id ?? null}
          ledgersByTaskId={ledgersByTaskId}
        />
      )}
```

(The Settings placeholder branch here is deliberately temporary — Task 9, immediately following this one, replaces it with the real Settings tab. This is not a shipped placeholder; it exists for exactly one task's duration and Task 9's own typecheck/test gate confirms it's gone.)

- [ ] **Step 8: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3100/repos/paulmeller/forge?tab=activity"`
Expected: `307` or `200`.

- [ ] **Step 9: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/repo-activity.ts apps/web/src/lib/repo-activity.test.ts "apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/activity-tab.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): Issues/Activity/Settings tabs shell + Activity tab"
```

---

### Task 9: Settings tab

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx`
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function updateRepoSettings(containerId: string, input: { concurrencyCap: number; budgetUsd: number | null; aiReviewEnabled: boolean; selfVerifyEnabled: boolean }): Promise<{ ok: true } | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Add the settings-update server action**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts`:

```ts
'use server';

import { eq } from 'drizzle-orm';

import { missions } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

export async function updateRepoSettings(
  containerId: string,
  input: {
    concurrencyCap: number;
    budgetUsd: number | null;
    aiReviewEnabled: boolean;
    selfVerifyEnabled: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  if (!Number.isInteger(input.concurrencyCap) || input.concurrencyCap < 1 || input.concurrencyCap > 100) {
    return { ok: false, error: 'Concurrency cap must be an integer between 1 and 100' };
  }
  if (input.budgetUsd !== null && (!Number.isInteger(input.budgetUsd) || input.budgetUsd < 1)) {
    return { ok: false, error: 'Budget must be a positive whole number of dollars, or blank' };
  }

  await db
    .update(missions)
    .set({
      concurrencyCap: input.concurrencyCap,
      budgetUsd: input.budgetUsd,
      aiReviewEnabled: input.aiReviewEnabled,
      selfVerifyEnabled: input.selfVerifyEnabled,
      updatedAt: new Date(),
    })
    .where(eq(missions.id, containerId));

  return { ok: true };
}
```

- [ ] **Step 2: Create the Settings tab component**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { updateRepoSettings } from './settings-actions';

export function SettingsTab({
  containerId,
  concurrencyCap,
  budgetUsd,
  aiReviewEnabled,
  selfVerifyEnabled,
}: {
  containerId: string;
  concurrencyCap: number;
  budgetUsd: number | null;
  aiReviewEnabled: boolean;
  selfVerifyEnabled: boolean;
}) {
  const [cap, setCap] = useState(String(concurrencyCap));
  const [budget, setBudget] = useState(budgetUsd !== null ? String(budgetUsd) : '');
  const [aiReview, setAiReview] = useState(aiReviewEnabled);
  const [selfVerify, setSelfVerify] = useState(selfVerifyEnabled);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function handleSave() {
    setMessage(null);
    const parsedCap = Number(cap);
    const parsedBudget = budget.trim() === '' ? null : Number(budget);
    startTransition(async () => {
      const result = await updateRepoSettings(containerId, {
        concurrencyCap: parsedCap,
        budgetUsd: parsedBudget,
        aiReviewEnabled: aiReview,
        selfVerifyEnabled: selfVerify,
      });
      setMessage(
        result.ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: result.error },
      );
    });
  }

  return (
    <div className="max-w-md space-y-4 rounded-lg border p-6">
      <div>
        <Label htmlFor="concurrencyCap">Concurrency cap</Label>
        <Input
          id="concurrencyCap"
          type="number"
          min={1}
          max={100}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Max issues this repo works at once, across all its issue missions.
        </p>
      </div>
      <div>
        <Label htmlFor="budgetUsd">Budget (USD, optional)</Label>
        <Input
          id="budgetUsd"
          type="number"
          min={1}
          placeholder="No cap"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-checkbox h-4 w-4"
          checked={aiReview}
          onChange={(e) => setAiReview(e.target.checked)}
        />
        AI review gate
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-checkbox h-4 w-4"
          checked={selfVerify}
          onChange={(e) => setSelfVerify(e.target.checked)}
        />
        Self-verify gate
      </label>
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={pending} variant="accent" size="sm">
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {message ? (
          <p className={`text-xs ${message.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the page, replacing Task 8's placeholder**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, add the import:

```ts
import { SettingsTab } from './settings-tab';
```

Replace the Settings placeholder branch from Task 8:

```tsx
      ) : activeTab === 'settings' ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Settings tab — see Task 9 of this plan.
        </div>
      ) : (
```

with:

```tsx
      ) : activeTab === 'settings' ? (
        mission ? (
          <SettingsTab
            containerId={mission.id}
            concurrencyCap={mission.concurrencyCap}
            budgetUsd={mission.budgetUsd}
            aiReviewEnabled={mission.aiReviewEnabled}
            selfVerifyEnabled={mission.selfVerifyEnabled}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No settings yet — work an issue in this repo first.
          </div>
        )
      ) : (
```

(`mission` is the existing container variable from `findWorkspaceMission`, already in scope.)

- [ ] **Step 4: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3100/repos/paulmeller/forge?tab=settings"`
Expected: `307` or `200`.

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): Settings tab — edit the container's concurrency/budget/gate knobs"
```

---

### Task 10: Issues tab — Next / Working / Inactive sections in the list

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`

**Interfaces:**
- Consumes: `row.group.headline` (existing, unchanged shape after Task 2), `mission.nextIssueRefs` (Task 1) — passed down as a new prop.
- Produces: adds a `nextIssueRefs: string[]` prop to `WorkspaceList`, and a `toggleNextMarker` call wired to a small button per row.

- [ ] **Step 1: Read the current full file**

Read `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx` in full (it was already touched mechanically in Task 2 — confirm its current state before this larger rework).

- [ ] **Step 2: Add the Next/Inactive sectioning and marker toggle**

Replace the whole file:

```tsx
'use client';

import { useMemo, useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type { WorkspaceIssueRow } from '@/lib/workspace-issues';

import { toggleNextMarker } from './actions';
import { IssueRunPanel } from './issue-run-panel';
import { WorkOnItButton } from './work-on-it-button';

const TERMINAL_HEADLINES = new Set(['fixed', 'not_reproduced', 'fix_skipped', 'failed']);

export function WorkspaceList({
  repo,
  rows,
  missionId,
  ledgersByTaskId,
  nextIssueRefs,
}: {
  repo: string;
  rows: WorkspaceIssueRow[];
  missionId: string | null;
  ledgersByTaskId: Record<
    string,
    Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>
  >;
  nextIssueRefs: string[];
}) {
  const [query, setQuery] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(rows[0]?.issue.number ?? null);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [showInactive, setShowInactive] = useState(false);
  const [pending, startTransition] = useTransition();

  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const row of rows) {
      for (const label of row.issue.labels ?? []) labels.add(label);
    }
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const toggleLabel = (label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQuery =
        !q || r.issue.title.toLowerCase().includes(q) || String(r.issue.number).includes(q);
      if (!matchesQuery) return false;
      if (selectedLabels.size === 0) return true;
      const issueLabels = new Set(r.issue.labels ?? []);
      return [...selectedLabels].every((label) => issueLabels.has(label));
    });
  }, [rows, query, selectedLabels]);

  function issueRefFor(row: WorkspaceIssueRow): string {
    return `${row.issue.repo}#${row.issue.number}`;
  }

  const nextSet = new Set(nextIssueRefs);
  const nextRows = filtered.filter((r) => nextSet.has(issueRefFor(r)));
  const inactiveRows = filtered.filter(
    (r) => r.group && TERMINAL_HEADLINES.has(r.group.headline) && !nextSet.has(issueRefFor(r)),
  );
  const workingRows = filtered.filter(
    (r) => !nextSet.has(issueRefFor(r)) && !(r.group && TERMINAL_HEADLINES.has(r.group.headline)),
  );

  const selected = filtered.find((r) => r.issue.number === selectedNumber) ?? filtered[0] ?? null;

  function handleToggleNext(row: WorkspaceIssueRow, marked: boolean) {
    startTransition(async () => {
      await toggleNextMarker(repo, issueRefFor(row), marked);
    });
  }

  function renderRow(row: WorkspaceIssueRow) {
    const ref = issueRefFor(row);
    return (
      <div
        key={row.issue.number}
        className={`flex items-center gap-1 border-b px-1 last:border-b-0 ${
          selected?.issue.number === row.issue.number ? 'bg-accent' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => setSelectedNumber(row.issue.number)}
          className="flex-1 py-2 text-left text-sm hover:bg-accent"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">#{row.issue.number}</span>
            {row.group ? (
              <span className="text-xs text-muted-foreground">{row.group.headline}</span>
            ) : null}
          </div>
          <p className="truncate">{row.issue.title}</p>
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => handleToggleNext(row, !nextSet.has(ref))}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={nextSet.has(ref) ? 'Remove from Next' : 'Mark as Next'}
        >
          {nextSet.has(ref) ? '★' : '☆'}
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        No open issues in {repo}.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-4">
      <div className="rounded-lg border">
        <div className="border-b p-2">
          <Input
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allLabels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {allLabels.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleLabel(label)}
                  aria-pressed={selectedLabels.has(label)}
                >
                  <Badge variant={selectedLabels.has(label) ? 'default' : 'outline'}>
                    {label}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {nextRows.length > 0 ? (
            <>
              <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Next
              </p>
              {nextRows.map(renderRow)}
            </>
          ) : null}

          <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Working
          </p>
          {workingRows.length > 0 ? (
            workingRows.map(renderRow)
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nothing in progress.</p>
          )}

          {inactiveRows.length > 0 ? (
            <div className="border-t">
              <button
                type="button"
                onClick={() => setShowInactive((v) => !v)}
                className="w-full px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {showInactive ? '▾' : '▸'} Inactive ({inactiveRows.length})
              </button>
              {showInactive ? inactiveRows.map(renderRow) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div>
        {selected ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-lg font-medium">
                #{selected.issue.number} {selected.issue.title}
              </h2>
              <a
                href={selected.issue.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                View on GitHub
              </a>
            </div>
            {selected.group && missionId ? (
              <IssueRunPanel
                group={selected.group}
                missionId={missionId}
                ledgersByTaskId={ledgersByTaskId}
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {selected.issue.body || 'No description.'}
              </p>
            )}
            <WorkOnItButton
              repo={repo}
              issue={selected.issue}
              headline={selected.group?.headline ?? null}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No issue matches your search.</p>
        )}
      </div>
    </div>
  );
}
```

`IssueRunPanel` still takes the Task 2-shimmed `group`/`missionId`/`reproduceLedger`/`fixLedger` props at this point in the plan — its real rework (a `ledgersByTaskId` map covering every attempt, not just the latest pair) is Task 11's job, right after this one. Keep this call site on the current shimmed shape:

```tsx
            {selected.group && missionId ? (
              <IssueRunPanel
                group={selected.group}
                missionId={missionId}
                reproduceLedger={
                  selected.group.attempts.at(-1)?.reproduce
                    ? (ledgersByTaskId[selected.group.attempts.at(-1)!.reproduce!.id] ?? [])
                    : []
                }
                fixLedger={
                  selected.group.attempts.at(-1)?.fix
                    ? (ledgersByTaskId[selected.group.attempts.at(-1)!.fix!.id] ?? [])
                    : []
                }
              />
            ) : (
```

(This mirrors Task 2's Step 6 shim exactly — still showing only the latest attempt — and keeps the build green. Task 11 replaces both `IssueRunPanel` and this call site together, atomically, with the real multi-attempt version.)

- [ ] **Step 3: Wire the new `nextIssueRefs` prop from the page**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, find the `<WorkspaceList .../>` call in the `'issues'` branch and add the prop:

```tsx
        <WorkspaceList
          repo={repo}
          rows={rows}
          missionId={mission?.id ?? null}
          ledgersByTaskId={ledgersByTaskId}
          nextIssueRefs={mission?.nextIssueRefs ?? []}
        />
```

- [ ] **Step 4: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/paulmeller/forge`
Expected: `307` or `200`.

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): Next/Working/Inactive sections in the issue list, Next marker toggle"
```

---

### Task 11: `IssueRunPanel` rework — attempt tabs, PR chips, Started timestamp, Abort

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Consumes: `abortTask` (Task 4), `Attempt`/`IssueGroup` (Task 2).
- Produces: `IssueRunPanel({ group, missionId, ledgersByTaskId }: { group: IssueGroup; missionId: string; ledgersByTaskId: Record<string, LedgerRow[]> })` — replaces the old `reproduceLedger`/`fixLedger` props with the whole map, since it now needs every attempt's tasks' ledgers, not just one pair's.

- [ ] **Step 1: Rewrite `IssueRunPanel`**

Replace `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx` in full:

```tsx
'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SessionLogView } from '@/components/session-log-view';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { IssueGroup } from '@/lib/triage-view';
import type { Task } from '@forge/db';

import { abortTask } from './actions';
import { AttemptFileBrowser } from './attempt-file-browser';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

const RUNNING_STATUSES = new Set(['queued', 'dispatching', 'running']);
const ABORTABLE_STATUSES = new Set(['dispatching', 'running', 'turn_ended', 'opening_pr']);

function formatStarted(task: Task | null): string | null {
  const at = task?.dispatchedAt ?? task?.createdAt ?? null;
  if (!at) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).format(at);
}

export function IssueRunPanel({
  group,
  missionId,
  ledgersByTaskId,
}: {
  group: IssueGroup;
  missionId: string;
  ledgersByTaskId: Record<string, LedgerRow[]>;
}) {
  const [attemptIndex, setAttemptIndex] = useState(group.attempts.length);
  const [stage, setStage] = useState<'reproduce' | 'fix'>('fix');
  const [pending, startTransition] = useTransition();
  const [abortError, setAbortError] = useState<string | null>(null);

  const attempt = group.attempts.find((a) => a.index === attemptIndex) ?? group.attempts.at(-1);
  if (!attempt) return <p className="text-xs text-muted-foreground">No attempts yet.</p>;

  const effectiveStage = attempt.fix ? stage : 'reproduce';
  const task = effectiveStage === 'reproduce' ? attempt.reproduce : attempt.fix;
  const ledger = task ? (ledgersByTaskId[task.id] ?? []) : [];
  const isLive = task ? RUNNING_STATUSES.has(task.status) : false;
  const verdict = attempt.reproduce?.verdict ?? null;
  const started = formatStarted(task);
  const canAbort = !!task && ABORTABLE_STATUSES.has(task.status);

  const prChips = group.attempts
    .map((a) => a.fix)
    .filter((f): f is Task => !!f?.prUrl);

  function handleAbort() {
    if (!task) return;
    setAbortError(null);
    startTransition(async () => {
      const result = await abortTask(task.id);
      if (!result.ok) setAbortError(result.error);
    });
  }

  return (
    <div className="space-y-3">
      {prChips.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {prChips.map((f) => (
            <a
              key={f.id}
              href={f.prUrl!}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-blue-500/40 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
            >
              PR #{f.prNumber} · {f.status}
            </a>
          ))}
        </div>
      ) : null}

      {verdict?.summary ? (
        <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          {verdict.summary}
        </p>
      ) : null}

      {group.attempts.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b">
          {group.attempts.map((a) => (
            <button
              key={a.index}
              type="button"
              onClick={() => setAttemptIndex(a.index)}
              className={`px-3 py-1.5 text-xs font-medium ${
                attemptIndex === a.index
                  ? 'border-b-2 border-[color:var(--forge-accent-to)] text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Attempt {a.index}
              {a.index === group.attempts.length ? ' ●' : ''}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex gap-1 border-b">
        {(['reproduce', 'fix'] as const).map((key) => {
          const t = key === 'reproduce' ? attempt.reproduce : attempt.fix;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setStage(key)}
              className={`px-3 py-1.5 text-xs font-medium capitalize ${
                effectiveStage === key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {key}
              {t ? (
                <span className="ml-1.5 inline-block align-middle">
                  <TaskStatusBadge status={t.status} haltReason={t.haltReason} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {task ? (
        <>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {started ? <span>Started {started}</span> : <span />}
            {canAbort ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 border-destructive/40 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                onClick={handleAbort}
                disabled={pending}
              >
                {pending ? 'Aborting…' : 'Abort'}
              </Button>
            ) : null}
          </div>
          {abortError ? <p className="text-xs text-destructive">{abortError}</p> : null}
          <SessionLogView
            taskId={task.id}
            isLive={isLive}
            initialEvents={ledger}
            maxLines={15}
            className="h-[200px]"
          />
          <AttemptFileBrowser task={task} ledger={ledger} />
          <Link
            href={`/missions/${missionId}/tasks/${task.id}`}
            className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View full run →
          </Link>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This stage hasn&apos;t started.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `WorkspaceList`'s `IssueRunPanel` call site to the new shape**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`, replace the Task 10 shim call:

```tsx
            {selected.group && missionId ? (
              <IssueRunPanel
                group={selected.group}
                missionId={missionId}
                reproduceLedger={
                  selected.group.attempts.at(-1)?.reproduce
                    ? (ledgersByTaskId[selected.group.attempts.at(-1)!.reproduce!.id] ?? [])
                    : []
                }
                fixLedger={
                  selected.group.attempts.at(-1)?.fix
                    ? (ledgersByTaskId[selected.group.attempts.at(-1)!.fix!.id] ?? [])
                    : []
                }
              />
            ) : (
```

with:

```tsx
            {selected.group && missionId ? (
              <IssueRunPanel
                group={selected.group}
                missionId={missionId}
                ledgersByTaskId={ledgersByTaskId}
              />
            ) : (
```

- [ ] **Step 3: Expand `page.tsx`'s ledger-fetching to cover every attempt, not just the latest**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, find the ledger-fetching block (built from Task 2's shim, reading only the latest attempt's two task ids). Replace it with one that collects every attempt's task ids across every issue row:

```tsx
  const ledgersByTaskIdMap = new Map<string, Awaited<ReturnType<typeof listLedgerForTask>>>();
  await Promise.all(
    rows.flatMap((row) => {
      const ids = (row.group?.attempts ?? []).flatMap((a) =>
        [a.reproduce?.id, a.fix?.id].filter((id): id is string => !!id),
      );
      return ids.map(async (id) => {
        ledgersByTaskIdMap.set(id, [...(await listLedgerForTask(id, 200))].reverse());
      });
    }),
  );
  const ledgersByTaskId = Object.fromEntries(ledgersByTaskIdMap);
```

- [ ] **Step 4: Create `AttemptFileBrowser`**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/attempt-file-browser.tsx`:

```tsx
'use client';

import { useMemo, useState } from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatLogLine, isToolEvent } from '@/lib/session-log-format';
import type { Task } from '@forge/db';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

type FileEntry = { name: string; content: string; modifiedAt: Date; sizeBytes: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Same synthesized files TaskFileTabs already computes for the Task detail
 * page (prompt.txt/agent.log/console.log/status.json), rendered here as a
 * Name/Modified/Size table matching the operator-console reference instead
 * of a tab bar. No new data source — same ledger/promptVars/verdict inputs.
 */
export function AttemptFileBrowser({ task, ledger }: { task: Task; ledger: LedgerRow[] }) {
  const [openFile, setOpenFile] = useState<string | null>(null);

  const chronological = useMemo(() => [...ledger].reverse(), [ledger]);
  const hasToolEvents = useMemo(() => chronological.some(isToolEvent), [chronological]);
  const latestEventAt = chronological.at(-1)?.createdAt ?? task.updatedAt;

  const files: FileEntry[] = useMemo(() => {
    const promptContent = JSON.stringify(task.promptVars ?? {}, null, 2);
    const agentLogContent =
      chronological.map((e) => formatLogLine(e)).join('\n') || 'No activity yet.';
    const statusContent = JSON.stringify({ status: task.status, verdict: task.verdict }, null, 2);

    const entries: FileEntry[] = [
      {
        name: 'prompt.txt',
        content: promptContent,
        modifiedAt: task.dispatchedAt ?? task.createdAt,
        sizeBytes: new Blob([promptContent]).size,
      },
      {
        name: 'agent.log',
        content: agentLogContent,
        modifiedAt: latestEventAt,
        sizeBytes: new Blob([agentLogContent]).size,
      },
    ];
    if (hasToolEvents) {
      const consoleContent =
        chronological.filter(isToolEvent).map((e) => formatLogLine(e)).join('\n') ||
        'No tool activity yet.';
      entries.push({
        name: 'console.log',
        content: consoleContent,
        modifiedAt: latestEventAt,
        sizeBytes: new Blob([consoleContent]).size,
      });
    }
    entries.push({
      name: 'status.json',
      content: statusContent,
      modifiedAt: task.updatedAt,
      sizeBytes: new Blob([statusContent]).size,
    });
    return entries;
  }, [task, chronological, hasToolEvents, latestEventAt]);

  const selected = files.find((f) => f.name === openFile) ?? null;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((f) => (
            <TableRow
              key={f.name}
              onClick={() => setOpenFile(openFile === f.name ? null : f.name)}
              className="cursor-pointer"
            >
              <TableCell className="font-mono text-xs">{f.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: 'numeric',
                }).format(f.modifiedAt)}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatSize(f.sizeBytes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selected ? (
        <pre className="max-h-[300px] overflow-auto border-t p-3 font-mono text-xs leading-relaxed">
          {selected.content}
        </pre>
      ) : null}
    </div>
  );
}
```

(`task.verdict` is a real column — `packages/db/src/schema.ts`'s `tasks` table has `verdict: text('verdict', { mode: 'json' }).$type<ReproduceVerdict>()`. `Blob` is a global available in the Next.js client bundle; no import needed.)

- [ ] **Step 5: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/paulmeller/forge`
Expected: `307` or `200`.

- [ ] **Step 6: Run the full web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/attempt-file-browser.tsx"
git commit -m "feat(workspace): attempt tabs, PR chips, Started + Abort, file browser table"
```

---

### Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every workspace's test suite**

Run: `pnpm test`
Expected: all suites pass across `@forge/web`, `@forge/tick`, `@forge/db`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification**

Ask the operator to confirm, against the real local app (`http://localhost:3100`), using a real connected repo with at least one worked issue (e.g. `paulmeller/forge`):

1. The header toolbar shows Deactivate/Activate (label matches the container's real status), Manual, Refresh, GitHub, and "Run a goal on this repo →", alongside the existing "+ New issue" and "View missions" buttons.
2. Clicking Deactivate flips the button to "Activate"; a fresh "Work on it" attempt (or the next tick) does NOT dispatch while deactivated — confirm via `sqlite3 packages/db/local.db "SELECT status FROM tasks WHERE ...;"` staying `queued`, not advancing to `dispatching`, until reactivated.
3. Clicking Manual triggers a real tick (compare `sqlite3` timestamps before/after, or watch a queued task advance).
4. The Issues/Activity/Settings tabs switch correctly; Activity lists both a campaign task (if one touches this repo) and issue-mission tasks together; Settings shows and saves the container's real concurrencyCap/budgetUsd/aiReviewEnabled/selfVerifyEnabled.
5. On an issue worked more than once ("Work again"), the detail pane shows an "Attempt 1 / Attempt 2 / …" tab row, and switching attempts shows that attempt's own reproduce/fix content — earlier attempts are no longer silently missing.
6. PR chips appear when any attempt's fix task has a `prUrl`.
7. The file browser table shows prompt.txt/agent.log/(console.log if tool events exist)/status.json with plausible Modified/Size values; clicking a row expands its content.
8. Abort is only visible on an in-flight attempt's active stage, and clicking it stops the session and marks the task failed with `manual_abort` (`sqlite3 packages/db/local.db "SELECT status, halt_reason FROM tasks WHERE id='...';"`).
9. The Next marker (★/☆ toggle) moves an issue into the "Next" section; clicking "Work on it" on it clears the mark and it moves out of "Next".
10. The Inactive section collapses closed/terminal issues by default and expands on click.

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
