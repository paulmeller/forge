# Home Work Queue, Steering, and Budget Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/home` as a needs-you-first work queue, add mid-run steering (message a running task), and surface budgets prominently — per the approved spec `docs/superpowers/specs/2026-07-17-home-queue-steering-budgets-design.md`.

**Architecture:** Three independent slices. (1) `/home` becomes three task-level sections (Needs you / Working / Recently done) fed by restored `lib/home.ts` queries. (2) A `steerTask` server action mirrors `abortTask`'s hardened pattern and sends a `user.message` event into the live session; a shared `SteerInput` client component renders under the consoles. (3) A pure `computeRepoBudget` helper plus a compact budget line in the repo console header.

**Tech Stack:** Next.js 15 App Router, React 19, Drizzle/libSQL, `@anthropic-ai/sdk` (already a web dep), vitest.

## Global Constraints

- **Every task's commit must leave the WHOLE monorepo typecheck-clean**: run `pnpm typecheck` from the repo root (all 4 workspace projects) before every commit — not just `pnpm --filter @forge/web typecheck`.
- `pnpm lint` fails repo-wide on a pre-existing `Cannot find package '@eslint/eslintrc'` error — known, unrelated, do NOT try to fix it.
- Server actions never trust client-supplied ids: capture `const user = await withAuth()` and scope every task lookup via `innerJoin(missions)` + `ownerId !== user.id → 'Task not found'` (two prior IDORs were found in this file; reviewers check for this).
- The steering event shape must match the tick adapter's `sendTurn` verbatim: `{ events: [{ type: 'user.message', content: [{ type: 'text', text }] }] }` sent via `client.beta.sessions.events.send(sessionId, …)` with an `as never` cast (SDK beta typing).
- Steerable statuses (UI gate): task has `sessionId` AND status ∈ `['dispatching', 'running', 'turn_ended', 'opening_pr']` — same set as the Abort button.
- Date formatting in client components must pass an explicit `'en-US'` locale to `Intl.DateTimeFormat` (locale-default formatting caused a hydration mismatch before).
- Working-section statuses: `['queued', 'dispatching', 'running', 'opening_pr', 'awaiting_ci', 'awaiting_verify', 'awaiting_ai_review', 'merging']`. Recently-done statuses: `['merged', 'resolved', 'abandoned']`. Needs-you statuses: `['awaiting_review', 'failed']` (halted tasks carry `haltReason` and end in `failed`).

---

### Task 1: Restore and extend the home queries

**Files:**
- Modify: `apps/web/src/lib/home.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  ```ts
  export type HomeTaskRow = { task: Task; missionId: string; missionName: string; isIssueMission: boolean };
  export function getNeedsYou(userId: string, limit = 20): Promise<HomeTaskRow[]>;
  export function getNowRunning(userId: string, limit = 20): Promise<HomeTaskRow[]>;
  export function getRecentOutcomes(userId: string, limit = 10): Promise<HomeTaskRow[]>;
  ```

- [ ] **Step 1: Restore the task-row queries**

`lib/home.ts` currently contains ONLY `DashboardStats`/`getDashboardStats` — `HomeTaskRow`, the shared query helper, and all three task queries were removed when `/home` dropped its rail. Restore them with the spec's status lists.

Replace the file's import block with:

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, missions, tasks, type Task, type TaskStatus } from '@forge/db';

import { db } from './db';
import { isIssueMission } from './mission-shape';
```

Then insert the following ABOVE the existing `export type DashboardStats` block:

```ts
export type HomeTaskRow = {
  task: Task;
  missionId: string;
  missionName: string;
  isIssueMission: boolean;
};

const NOW_RUNNING_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'merging',
] as const;

const NEEDS_YOU_STATUSES = ['awaiting_review', 'failed'] as const;

const RECENT_OUTCOME_STATUSES = ['merged', 'resolved', 'abandoned'] as const;

async function queryTasksByStatus(
  userId: string,
  statuses: readonly TaskStatus[],
  limit: number,
  orderByCompletedAt: boolean,
): Promise<HomeTaskRow[]> {
  const rows = await db
    .select({
      task: tasks,
      missionId: missions.id,
      missionName: missions.name,
      issueRef: missions.issueRef,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), inArray(tasks.status, statuses)))
    .orderBy(orderByCompletedAt ? desc(tasks.completedAt) : desc(tasks.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    task: r.task,
    missionId: r.missionId,
    missionName: r.missionName,
    isIssueMission: isIssueMission({ issueRef: r.issueRef }),
  }));
}

/** In-flight Tasks across both modes — the Working section. */
export function getNowRunning(userId: string, limit = 20): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NOW_RUNNING_STATUSES, limit, false);
}

/** Tasks that need a human — awaiting review, or failed/halted. */
export function getNeedsYou(userId: string, limit = 20): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, NEEDS_YOU_STATUSES, limit, false);
}

/** Most recent terminal results — merged, resolved, or abandoned. */
export function getRecentOutcomes(userId: string, limit = 10): Promise<HomeTaskRow[]> {
  return queryTasksByStatus(userId, RECENT_OUTCOME_STATUSES, limit, true);
}
```

`getDashboardStats` and its `DashboardStats` type stay exactly as they are, below the inserted block.

- [ ] **Step 2: Typecheck (whole repo)**

Run from repo root: `pnpm typecheck`
Expected: clean across packages/db, spikes/ma-api-audit, apps/tick, apps/web.

- [ ] **Step 3: Run the web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass (152 tests at plan time).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/home.ts
git commit -m "feat(home): restore getNowRunning/getRecentOutcomes with queue status lists"
```

---

### Task 2: `/home` becomes the work queue

**Files:**
- Create: `apps/web/src/components/queue-section.tsx`
- Modify: `apps/web/src/app/(app)/home/page.tsx`

**Interfaces:**
- Consumes: `getNeedsYou`/`getNowRunning`/`getRecentOutcomes` (Task 1), `parseIssueRef` (`@/lib/mission-shape`), `tokensToUsd` (`@/lib/rollups`), `TaskProgressPill`/`TaskRollup` + `rollupTasks`, `TaskStatusBadge`, `LiveRefresh`.
- Produces: `QueueSection({ title, rows, rollups, empty, live })` — a server-renderable list section.

- [ ] **Step 1: Create the queue section component**

Create `apps/web/src/components/queue-section.tsx`:

```tsx
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { TaskProgressPill, type TaskRollup } from '@/components/progress-pill';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { HomeTaskRow } from '@/lib/home';
import { parseIssueRef } from '@/lib/mission-shape';
import { tokensToUsd } from '@/lib/rollups';

function hrefFor(row: HomeTaskRow): string {
  const parsed = row.task.issueRef ? parseIssueRef(row.task.issueRef) : null;
  return parsed
    ? `/repos/${parsed.repo}?issue=${parsed.number}`
    : `/missions/${row.task.missionId}/tasks/${row.task.id}`;
}

function formatRelative(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CostChip({ costTokens }: { costTokens: number }) {
  const usd = tokensToUsd(costTokens);
  if (usd <= 0) return null;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
      {usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(0)}`}
    </span>
  );
}

export function QueueSection({
  title,
  rows,
  rollups,
  empty,
  live = false,
}: {
  title: string;
  rows: HomeTaskRow[];
  rollups?: Map<string, TaskRollup>;
  empty: string;
  live?: boolean;
}) {
  return (
    <div className="rounded-lg border">
      <p className="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="p-2">
        {rows.length === 0 ? (
          <p className="px-1 py-1 text-sm text-muted-foreground">{empty}</p>
        ) : (
          rows.map((row) => {
            const { task, missionName, isIssueMission } = row;
            const rollup = rollups?.get(task.id);
            return (
              <Link
                key={task.id}
                href={hrefFor(row)}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {live ? (
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                        aria-hidden
                      />
                    ) : null}
                    <p className="truncate font-medium">{task.issueRef ?? missionName}</p>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">{task.repo}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {rollup ? <TaskProgressPill rollup={rollup} /> : null}
                  {task.prUrl ? (
                    <span className="rounded border border-blue-500/40 px-1.5 py-0.5 text-[11px] text-blue-600 dark:text-blue-400">
                      PR #{task.prNumber}
                    </span>
                  ) : null}
                  <CostChip costTokens={task.costTokens} />
                  {isIssueMission ? (
                    <Badge variant="outline" className="text-[10px]">
                      Issue
                    </Badge>
                  ) : null}
                  <TaskStatusBadge status={task.status} haltReason={task.haltReason} />
                  <span
                    className="w-14 text-right text-[11px] tabular-nums text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {formatRelative(task.updatedAt)}
                  </span>
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
```

Note: `formatRelative` depends on `Date.now()`, so the span carries `suppressHydrationWarning` (same convention as `progress-pill.tsx`'s time-sensitive chips). The PR chip and cost chip render inside the row's flex tail; `TaskProgressPill` only receives a rollup for the Working section (see Step 2).

- [ ] **Step 2: Rewrite the home page**

Replace `apps/web/src/app/(app)/home/page.tsx` in full:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Button } from '@/components/ui/button';
import { LiveRefresh } from '@/components/live-refresh';
import { QueueSection } from '@/components/queue-section';
import { db } from '@/lib/db';
import { getDashboardStats, getNeedsYou, getNowRunning, getRecentOutcomes } from '@/lib/home';
import { rollupTasks } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .limit(1);
  if (!installation) redirect('/setup');

  const [stats, needsYou, nowRunning, recentOutcomes] = await Promise.all([
    getDashboardStats(user.id),
    getNeedsYou(user.id),
    getNowRunning(user.id),
    getRecentOutcomes(user.id),
  ]);
  const runningRollups = await rollupTasks(nowRunning.map((r) => r.task.id));

  return (
    <main className="container max-w-[1400px] py-10">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-title text-3xl uppercase tracking-tight">Home</h1>
            {nowRunning.length > 0 ? <LiveRefresh intervalMs={5000} /> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            What needs you, what&apos;s running, what just landed.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/missions">View all missions →</Link>
        </Button>
      </div>

      {stats.connectedRepos === 0 && (
        <div className="mb-8 rounded-lg border border-dashed border-yellow-600/40 bg-yellow-950/20 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Connect your repos to get started</p>
              <p className="text-xs text-muted-foreground">
                Install the GitHub App and select repos. Then comment{' '}
                <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/setup">Connect Repos</Link>
            </Button>
          </div>
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.mergedThisWeek}</p>
          <p className="text-xs text-muted-foreground">PRs merged this week</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.activeAgents}</p>
          <p className="text-xs text-muted-foreground">Active agents</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">${stats.spentUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Total spend</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.connectedRepos}</p>
          <p className="text-xs text-muted-foreground">Connected repos</p>
        </div>
      </div>

      <div className="space-y-6">
        <QueueSection
          title="Needs you"
          rows={needsYou}
          empty="Nothing waiting on you."
        />
        <QueueSection
          title="Working"
          rows={nowRunning}
          rollups={runningRollups}
          empty="Nothing running right now."
          live
        />
        <QueueSection
          title="Recently done"
          rows={recentOutcomes}
          empty="No merged PRs or resolved issues yet."
        />
      </div>
    </main>
  );
}
```

Removed relative to the current file: the missions table, `MissionFilters`, `filterMissionList`, `MissionsTable` imports, and the `searchParams` prop (no filters on the queue). `/missions` is untouched and keeps the table.

- [ ] **Step 3: Typecheck (whole repo)**

Run: `pnpm typecheck` — expected clean. (If `filterMissionList`/`MissionsTable` become unused anywhere, they are still used by `/missions` — do not delete them.)

- [ ] **Step 4: Run the web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 5: Dev-server smoke check**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/home`
Expected: `307` or `200` (best-effort; skip if no dev server is running).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/queue-section.tsx "apps/web/src/app/(app)/home/page.tsx"
git commit -m "feat(home): needs-you-first work queue replaces the missions table"
```

---

### Task 3: `steerTask` server action

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Produces:
  ```ts
  export function steerTask(taskId: string, message: string): Promise<{ ok: true } | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Add the helper and action**

Read the current file first. Directly below the existing `cancelManagedAgentsSession` helper, add:

```ts
async function sendSteeringMessage(sessionId: string, text: string): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text }],
      },
    ],
  } as never);
}
```

Directly below the existing `abortTask` function, add:

```ts
/**
 * Send a mid-run instruction into a Task's live session. The message is
 * appended to the session's event stream (same `user.message` shape the
 * dispatcher uses for the opening turn) and recorded in the audit ledger.
 */
export async function steerTask(
  taskId: string,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();

  const text = message.trim();
  if (!text) return { ok: false, error: 'Message is empty' };

  const [row] = await db
    .select({ task: tasks, ownerId: missions.userId })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row || row.ownerId !== user.id) return { ok: false, error: 'Task not found' };
  const task = row.task;
  if (!task.sessionId) return { ok: false, error: 'Task has no active session to steer' };
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, error: 'Task has already finished, nothing to steer' };
  }

  try {
    await sendSteeringMessage(task.sessionId, text);
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach session: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'task.steered',
    payload: { sessionId: task.sessionId, message: text },
    createdAt: new Date(),
  });

  return { ok: true };
}
```

No new imports are needed — `Anthropic`, `env`, `randomUUID`, `ledgerEvents`, `missions`, `tasks`, `eq`, `db`, `withAuth`, and `TERMINAL_TASK_STATUSES` are all already in the file. A single ledger insert follows the successful send; there is no task-row mutation, so no transaction (deliberate — documented in the spec).

- [ ] **Step 2: Typecheck (whole repo)**

Run: `pnpm typecheck` — expected clean.

- [ ] **Step 3: Run the web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass (no dedicated test file — matches the convention for `abortTask`/`workOnIssue`: server actions with live network calls).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): steerTask — send a mid-run instruction into a live session, ledger-recorded"
```

---

### Task 4: `SteerInput` component, wired into both consoles

**Files:**
- Create: `apps/web/src/components/steer-input.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `steerTask` (Task 3).
- Produces: `SteerInput({ taskId }: { taskId: string })` — client component.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/steer-input.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { steerTask } from '@/app/(app)/repos/[owner]/[repo]/actions';

export function SteerInput({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSend() {
    if (!message.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await steerTask(taskId, message);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage('');
    });
  }

  return (
    <div className="shrink-0">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Send an instruction to the running agent…"
          disabled={pending}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !message.trim()}>
          {pending ? 'Sending…' : 'Send'}
        </Button>
      </form>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
```

On failure the typed message is preserved (only cleared on success), so the user can retry.

- [ ] **Step 2: Wire into `IssueRunPanel`**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`:

Add the import: `import { SteerInput } from '@/components/steer-input';`

The file already computes `canAbort = !!task && ABORTABLE_STATUSES.has(task.status)`. Add beside it:

```ts
  const canSteer = !!task && !!task.sessionId && ABORTABLE_STATUSES.has(task.status);
```

Then, directly below the console block (the `div` wrapping `SessionLogView`, which ends with `</div>` after the `SessionLogView` element) and above the "View full run →" link, insert:

```tsx
          {canSteer && task ? <SteerInput taskId={task.id} /> : null}
```

- [ ] **Step 3: Wire into the task detail page**

In `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`:

Add the import: `import { SteerInput } from '@/components/steer-input';`

In the "Run" card, directly after the `<SessionLogView … />` element, insert:

```tsx
          {task.sessionId &&
          ['dispatching', 'running', 'turn_ended', 'opening_pr'].includes(task.status) ? (
            <SteerInput taskId={task.id} />
          ) : null}
```

- [ ] **Step 4: Typecheck (whole repo)**

Run: `pnpm typecheck` — expected clean.

- [ ] **Step 5: Run the web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/steer-input.tsx "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx" "apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx"
git commit -m "feat(workspace): SteerInput under the live consoles — message a running task"
```

---

### Task 5: `computeRepoBudget` helper + query (TDD)

**Files:**
- Create: `apps/web/src/lib/repo-budget.ts`
- Create: `apps/web/src/lib/repo-budget.test.ts`

**Interfaces:**
- Produces (consumed by Task 6):
  ```ts
  export type RepoBudget = { spentUsd: number; capUsd: number | null; pct: number | null };
  export function computeRepoBudget(
    rows: Array<Pick<Mission, 'spentUsd' | 'budgetUsd' | 'issueRef' | 'parentMissionId'>>,
  ): RepoBudget;
  export function getRepoBudget(userId: string, repo: string): Promise<RepoBudget>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/repo-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { computeRepoBudget } from './repo-budget';

type Row = Parameters<typeof computeRepoBudget>[0][number];

function container(over: Partial<Row> = {}): Row {
  return { spentUsd: 0, budgetUsd: null, issueRef: null, parentMissionId: null, ...over };
}
function leaf(over: Partial<Row> = {}): Row {
  return { spentUsd: 0, budgetUsd: null, issueRef: 'acme/api#1', parentMissionId: 'msn_c', ...over };
}

describe('computeRepoBudget', () => {
  it('returns zeros and no cap for an empty repo', () => {
    expect(computeRepoBudget([])).toEqual({ spentUsd: 0, capUsd: null, pct: null });
  });

  it('sums spend across container and leaves, cap from the container', () => {
    const rows = [
      container({ budgetUsd: 100 }),
      leaf({ spentUsd: 12.5 }),
      leaf({ spentUsd: 7.5, issueRef: 'acme/api#2' }),
    ];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 20, capUsd: 100, pct: 20 });
  });

  it('reports no cap (null pct) when the container has no budget', () => {
    const rows = [container(), leaf({ spentUsd: 3 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 3, capUsd: null, pct: null });
  });

  it('pct can exceed 100 when over budget', () => {
    const rows = [container({ budgetUsd: 10 }), leaf({ spentUsd: 25 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 25, capUsd: 10, pct: 250 });
  });

  it('ignores a leaf-level budgetUsd — only the container defines the cap', () => {
    const rows = [container({ budgetUsd: 50 }), leaf({ spentUsd: 5, budgetUsd: 999 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 5, capUsd: 50, pct: 10 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @forge/web test -- repo-budget`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/repo-budget.ts`:

```ts
import { and, eq } from 'drizzle-orm';

import { missions, type Mission } from '@forge/db';

import { db } from './db';

export type RepoBudget = { spentUsd: number; capUsd: number | null; pct: number | null };

/**
 * Roll a repo's missions up into one budget line. Spend is summed across
 * every mission (containers hold no tasks so their spend is 0; issue leaves
 * accrue it). The cap comes from the container — the pure envelope with no
 * issueRef and no parent.
 */
export function computeRepoBudget(
  rows: Array<Pick<Mission, 'spentUsd' | 'budgetUsd' | 'issueRef' | 'parentMissionId'>>,
): RepoBudget {
  const spentUsd = rows.reduce((sum, r) => sum + (r.spentUsd ?? 0), 0);
  const containerRow = rows.find((r) => !r.issueRef && !r.parentMissionId);
  const capUsd = containerRow?.budgetUsd ?? null;
  const pct = capUsd && capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : null;
  return { spentUsd, capUsd, pct };
}

/** All of one user's missions for a repo (container + issue leaves), rolled up. */
export async function getRepoBudget(userId: string, repo: string): Promise<RepoBudget> {
  const rows = await db
    .select({
      spentUsd: missions.spentUsd,
      budgetUsd: missions.budgetUsd,
      issueRef: missions.issueRef,
      parentMissionId: missions.parentMissionId,
    })
    .from(missions)
    .where(and(eq(missions.userId, userId), eq(missions.workspaceRepo, repo)));
  return computeRepoBudget(rows);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @forge/web test -- repo-budget`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck (whole repo)**

Run: `pnpm typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/repo-budget.ts apps/web/src/lib/repo-budget.test.ts
git commit -m "feat(budget): computeRepoBudget/getRepoBudget — per-repo spend rollup with container cap"
```

---

### Task 6: Budget line in the repo console header

**Files:**
- Create: `apps/web/src/components/repo-budget-line.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Consumes: `getRepoBudget`/`RepoBudget` (Task 5).
- Produces: `RepoBudgetLine({ budget }: { budget: RepoBudget })`.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/repo-budget-line.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { RepoBudget } from '@/lib/repo-budget';

function usd(n: number): string {
  return n < 1 && n > 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
}

/** Compact one-line budget readout for the repo console header. */
export function RepoBudgetLine({ budget }: { budget: RepoBudget }) {
  const { spentUsd, capUsd, pct } = budget;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="font-mono tabular-nums">
        Spent {usd(spentUsd)}
        {capUsd !== null ? ` · cap ${usd(capUsd)}` : ' · no cap'}
      </span>
      {pct !== null ? (
        <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              'absolute inset-y-0 left-0 rounded-full',
              pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-foreground',
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
```

The tone thresholds (80% warn, 100% over) mirror `BudgetGauge`'s defaults at compact scale.

- [ ] **Step 2: Wire into the repo console page**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`:

Add imports:

```ts
import { RepoBudgetLine } from '@/components/repo-budget-line';
import { getRepoBudget } from '@/lib/repo-budget';
```

After the existing `const mission = await findWorkspaceMission(user.id, repo);` line, add:

```ts
  const repoBudget = await getRepoBudget(user.id, repo);
```

Then find the header block:

```tsx
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
            {hasActiveWork ? <LiveRefresh intervalMs={5000} /> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} open issue{rows.length === 1 ? '' : 's'}
          </p>
```

and replace with:

```tsx
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
            {hasActiveWork ? <LiveRefresh intervalMs={5000} /> : null}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {rows.length} open issue{rows.length === 1 ? '' : 's'}
            </p>
            <RepoBudgetLine budget={repoBudget} />
          </div>
```

- [ ] **Step 3: Typecheck (whole repo)**

Run: `pnpm typecheck` — expected clean.

- [ ] **Step 4: Run the web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/repo-budget-line.tsx "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(budget): compact spend/cap line in the repo console header"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every workspace's suite and typecheck**

Run from repo root: `pnpm typecheck && pnpm test`
Expected: typecheck clean across all 4 projects; all web + tick suites pass (tick unchanged: 202 tests; web grows by the 5 repo-budget tests).

- [ ] **Step 2: Live browser walkthrough (operator or controller with browser access)**

Against `http://localhost:3100` with the sandbox repo (`paulmeller/forge-sandbox`):

1. `/home` shows three sections in order (Needs you / Working / Recently done) with the metric cards on top; no missions table; "View all missions →" reaches `/missions`, which still has the table.
2. Rows show status badge, cost chip (non-zero tasks only), PR chip where set, relative time; issue rows deep-link to `/repos/{repo}?issue={n}` with the issue pre-selected; the LiveRefresh pill appears only while something is in the Working section.
3. Dispatch a sandbox issue ("Work on it"). While it runs: the steering input appears under the console in the repo console; send an instruction; confirm (a) no error, (b) a `task.steered` ledger event with the message payload appears on the task detail page's Ledger card, (c) the instruction visibly lands in the live console stream, and — strongest signal — (d) the agent's subsequent behavior references the instruction.
4. Steering input is absent on finished tasks (both consoles); present on the task detail page while running.
5. Repo console header shows `Spent $X · cap $Y` with the bar (set a cap via Settings tab to see it) or `no cap` otherwise; numbers match the Settings/mission budget values.
6. Abort still works; hydration console is clean (no locale mismatch warnings).

- [ ] **Step 3: Report**

Summarize pass/fail per check. Do not mark this task complete if any automated check fails; browser checks that cannot run in the environment are deferred to the operator with a concrete checklist.
