# Autonomous Building Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM Planner (DAG decomposition), AI Review Gate (direct Claude API), and AGENTS.md injection so Forge can autonomously plan, execute, review, and merge multi-step coding work.

**Architecture:** Three independent features layered onto the existing tick loop. Schema migration adds `dependsOnIds`, `aiReviewRetryCount`, `aiReviewEnabled`, and `awaiting_ai_review` status. The LLM planner runs at plan time in the web app. The AI review runs as a new tick subsystem using direct `messages.create` calls. AGENTS.md is fetched and cached per-repo at dispatch time.

**Tech Stack:** Drizzle/libSQL, Fastify tick service, Next.js web app, Anthropic SDK (`messages.create`), Octokit, vitest

---

### Task 1: Schema migration — new fields and status

**Files:**
- Modify: `packages/db/src/schema.ts:20-33` (taskStatus enum), `:57` (missions), `:79` (tasks dependsOn)
- Create: `packages/db/migrations/0007_autonomous.sql`

- [ ] **Step 1: Add `awaiting_ai_review` to taskStatus enum**

In `packages/db/src/schema.ts`, replace lines 20-32:

```typescript
export const taskStatus = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
  'abandoned',
  'failed',
] as const;
```

- [ ] **Step 2: Add `aiReviewEnabled` to missions table**

In `packages/db/src/schema.ts`, after `skillId` (line 57), add:

```typescript
  aiReviewEnabled: integer('ai_review_enabled', { mode: 'boolean' }).notNull().default(false),
```

- [ ] **Step 3: Replace `dependsOn` with `dependsOnIds` on tasks**

In `packages/db/src/schema.ts`, replace line 79:

```typescript
    dependsOnIds: text('depends_on_ids', { mode: 'json' }).$type<string[]>(),
```

Update the index at line 102:

```typescript
    index('tasks_depends_on_idx').on(t.dependsOnIds),
```

- [ ] **Step 4: Add `aiReviewRetryCount` to tasks**

After `retryCount` (line 87), add:

```typescript
    aiReviewRetryCount: integer('ai_review_retry_count').notNull().default(0),
```

- [ ] **Step 5: Add `awaiting_ai_review` to task-status-badge**

In `apps/web/src/components/task-status-badge.tsx`, add to the VARIANT record:

```typescript
  awaiting_ai_review: 'secondary',
```

- [ ] **Step 6: Generate migration**

Run: `cd packages/db && pnpm drizzle-kit generate`

Rename the generated file to `0007_autonomous.sql`. Update `meta/_journal.json` tag to match.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter db typecheck`
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add packages/db/ apps/web/src/components/task-status-badge.tsx
git commit -m "feat(db): migration 0007 — dependsOnIds, aiReviewEnabled, awaiting_ai_review"
```

---

### Task 2: Update status arrays across tick subsystems

**Files:**
- Modify: `apps/tick/src/dispatcher.ts:14-21`
- Modify: `apps/tick/src/budgets.ts:47-59`
- Modify: `apps/tick/src/dispatcher.test.ts:23`
- Modify: `apps/tick/src/reconciler.test.ts:27-29`

- [ ] **Step 1: Write failing test — dispatcher inflight count is now 8**

In `apps/tick/src/dispatcher.test.ts`, update line 23:

```typescript
  it('has exactly 8 statuses (no accidental additions)', () => {
    expect(INFLIGHT_STATUSES).toHaveLength(8);
  });
```

Add a new assertion:

```typescript
  it('includes awaiting_ai_review', () => {
    expect(INFLIGHT_STATUSES).toContain('awaiting_ai_review');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter tick test -- src/dispatcher.test.ts`
Expected: FAIL — length is 7, missing awaiting_ai_review

- [ ] **Step 3: Add `awaiting_ai_review` to INFLIGHT_STATUSES**

In `apps/tick/src/dispatcher.ts`, add after `'awaiting_ci'` (line 19):

```typescript
  'awaiting_ai_review',
```

- [ ] **Step 4: Add `awaiting_ai_review` to ALL_TASK_STATUSES in budgets**

In `apps/tick/src/budgets.ts`, add after `'awaiting_ci'` (line 53):

```typescript
  'awaiting_ai_review',
```

- [ ] **Step 5: Update reconciler test — awaiting_ai_review excluded from terminal**

In `apps/tick/src/reconciler.test.ts`, add inside the "excludes active execution states" test:

```typescript
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('awaiting_ai_review');
```

- [ ] **Step 6: Run all tests**

Run: `pnpm --filter tick test`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add apps/tick/src/dispatcher.ts apps/tick/src/budgets.ts apps/tick/src/dispatcher.test.ts apps/tick/src/reconciler.test.ts
git commit -m "fix(tick): add awaiting_ai_review to all status arrays"
```

---

### Task 3: DAG validation — pure cycle detection

**Files:**
- Create: `apps/tick/src/dag.ts`
- Create: `apps/tick/src/dag.test.ts`

- [ ] **Step 1: Write failing tests for cycle detection**

Create `apps/tick/src/dag.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { validateDag } from './dag';

describe('validateDag', () => {
  it('accepts an empty task list', () => {
    expect(validateDag([])).toEqual({ valid: true, error: null });
  });

  it('accepts independent tasks (no dependencies)', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('accepts a linear chain A → B → C', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [1] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('accepts a diamond A → B, A → C, B → D, C → D', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [0] },
      { index: 3, dependsOnIndices: [1, 2] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('rejects a direct cycle A → B → A', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [1] },
      { index: 1, dependsOnIndices: [0] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cycle');
  });

  it('rejects a self-referencing task', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [0] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
  });

  it('rejects an indirect cycle A → B → C → A', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [2] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [1] },
    ];
    expect(validateDag(tasks).valid).toBe(false);
  });

  it('rejects out-of-bounds dependency index', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [5] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('out of bounds');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter tick test -- src/dag.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement validateDag**

Create `apps/tick/src/dag.ts`:

```typescript
type TaskNode = {
  index: number;
  dependsOnIndices: number[];
};

type DagResult = { valid: true; error: null } | { valid: false; error: string };

/**
 * Validate that a list of tasks with index-based dependencies forms a DAG
 * (no cycles). Uses iterative DFS with a three-color marking scheme.
 */
export function validateDag(tasks: TaskNode[]): DagResult {
  const n = tasks.length;

  // Check bounds first
  for (const task of tasks) {
    for (const dep of task.dependsOnIndices) {
      if (dep < 0 || dep >= n) {
        return { valid: false, error: `task ${task.index} depends on index ${dep} which is out of bounds (0-${n - 1})` };
      }
    }
  }

  // Build adjacency list (dependency → dependent, but we walk edges in reverse: dependent → dependency)
  // For cycle detection, direction doesn't matter — we're checking the dependency graph.
  const adj = new Map<number, number[]>();
  for (const task of tasks) {
    adj.set(task.index, task.dependsOnIndices);
  }

  // 0 = unvisited, 1 = visiting (in current DFS path), 2 = done
  const state = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (state[i] === 2) continue;

    // Iterative DFS using an explicit stack
    const stack: Array<{ node: number; childIdx: number }> = [{ node: i, childIdx: 0 }];
    state[i] = 1;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = adj.get(frame.node) ?? [];

      if (frame.childIdx >= deps.length) {
        state[frame.node] = 2;
        stack.pop();
        continue;
      }

      const child = deps[frame.childIdx]!;
      frame.childIdx += 1;

      if (state[child] === 1) {
        return { valid: false, error: `cycle detected involving task indices ${child} and ${frame.node}` };
      }
      if (state[child] === 0) {
        state[child] = 1;
        stack.push({ node: child, childIdx: 0 });
      }
    }
  }

  return { valid: true, error: null };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter tick test -- src/dag.test.ts`
Expected: all 8 pass

- [ ] **Step 5: Commit**

```bash
git add apps/tick/src/dag.ts apps/tick/src/dag.test.ts
git commit -m "feat(tick): DAG cycle validation for LLM planner"
```

---

### Task 4: LLM Planner — web-side decomposition

**Files:**
- Create: `apps/web/src/lib/llm-planner.ts`
- Modify: `apps/web/src/lib/planner.ts:38-96`

- [ ] **Step 1: Create the LLM planner module**

Create `apps/web/src/lib/llm-planner.ts`:

```typescript
import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type NewTask } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { PlannerError, type PlanResult } from './planner';

type LlmTask = {
  repo: string;
  label: string;
  prompt: string;
  dependsOnIndices: number[];
};

type LlmPlannerResponse = {
  reasoning: string;
  tasks: LlmTask[];
};

// Inline validateDag to avoid cross-package import from tick
function validateDag(nodes: Array<{ index: number; dependsOnIndices: number[] }>): { valid: boolean; error: string | null } {
  const n = nodes.length;
  for (const node of nodes) {
    for (const dep of node.dependsOnIndices) {
      if (dep < 0 || dep >= n) return { valid: false, error: `index ${dep} out of bounds` };
    }
  }
  const state = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (state[i] === 2) continue;
    const stack: Array<{ node: number; childIdx: number }> = [{ node: i, childIdx: 0 }];
    state[i] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = nodes[frame.node]?.dependsOnIndices ?? [];
      if (frame.childIdx >= deps.length) { state[frame.node] = 2; stack.pop(); continue; }
      const child = deps[frame.childIdx]!;
      frame.childIdx += 1;
      if (state[child] === 1) return { valid: false, error: `cycle at ${child}↔${frame.node}` };
      if (state[child] === 0) { state[child] = 1; stack.push({ node: child, childIdx: 0 }); }
    }
  }
  return { valid: true, error: null };
}

const SYSTEM_PROMPT = `You are decomposing a software engineering goal into discrete tasks for autonomous coding agents.

Return JSON only — no markdown fences, no commentary outside the JSON.

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
- Each task targets exactly one repo from the allowed list.
- A task's prompt should be self-contained — the agent won't see other tasks.
- Use dependsOnIndices to express ordering (0-indexed into this array).
- Only add dependencies when the output of one task is genuinely required by another.
- Prefer independent tasks when possible — parallelism is cheaper than sequencing.
- Do NOT create more than 20 tasks.`;

export async function runLlmPlanner(missionId: string): Promise<PlanResult> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  if (!mission) throw new PlannerError('mission not found', 'MISSION_NOT_FOUND');
  if (mission.status !== 'draft') {
    throw new PlannerError(
      `mission is ${mission.status}; planner only runs on draft`,
      mission.status === 'planning' ? 'ALREADY_PLANNED' : 'WRONG_STATUS',
    );
  }
  const repos = mission.targetRepos ?? [];
  if (repos.length === 0) {
    throw new PlannerError('mission has no target repos', 'NO_TARGET_REPOS');
  }

  if (!env.ANTHROPIC_API_KEY) {
    throw new PlannerError('ANTHROPIC_API_KEY required for LLM planner', 'WRONG_STATUS');
  }

  // Call Claude OUTSIDE the DB transaction to avoid holding a write lock
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const userPrompt = `Goal: ${mission.goal}\nTarget repositories: ${repos.join(', ')}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed: LlmPlannerResponse;
  try {
    parsed = JSON.parse(text) as LlmPlannerResponse;
  } catch {
    throw new PlannerError(`LLM returned invalid JSON: ${text.slice(0, 200)}`, 'WRONG_STATUS');
  }

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new PlannerError('LLM returned no tasks', 'WRONG_STATUS');
  }
  if (parsed.tasks.length > 20) {
    throw new PlannerError(`LLM returned ${parsed.tasks.length} tasks (max 20)`, 'WRONG_STATUS');
  }

  // Validate repos
  const repoSet = new Set(repos);
  for (const t of parsed.tasks) {
    if (!repoSet.has(t.repo)) {
      throw new PlannerError(`LLM task targets unknown repo: ${t.repo}`, 'WRONG_STATUS');
    }
  }

  // Validate DAG
  const dagNodes = parsed.tasks.map((t, i) => ({ index: i, dependsOnIndices: t.dependsOnIndices ?? [] }));
  const dagResult = validateDag(dagNodes);
  if (!dagResult.valid) {
    throw new PlannerError(`LLM produced cyclic dependencies: ${dagResult.error}`, 'WRONG_STATUS');
  }

  // Insert inside transaction
  return db.transaction(async (tx) => {
    const now = new Date();

    // Create task rows with temporary IDs
    const taskRows: (NewTask & { _idx: number })[] = parsed.tasks.map((t, i) => ({
      _idx: i,
      id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      repo: t.repo,
      baseBranch: 'main',
      status: 'queued',
      promptVars: { repo: t.repo, base_branch: 'main', label: t.label, custom_prompt: t.prompt },
      createdAt: now,
      updatedAt: now,
    }));

    // Resolve index-based dependencies to real task IDs
    for (const row of taskRows) {
      const llmTask = parsed.tasks[row._idx]!;
      const depIds = (llmTask.dependsOnIndices ?? [])
        .map((idx) => taskRows[idx]?.id)
        .filter((id): id is string => !!id);
      if (depIds.length > 0) {
        (row as Record<string, unknown>).dependsOnIds = depIds;
      }
    }

    // Strip _idx before insert
    const insertRows: NewTask[] = taskRows.map(({ _idx, ...rest }) => rest);
    await tx.insert(tasks).values(insertRows);

    const [updated] = await tx
      .update(missions)
      .set({ status: 'planning', updatedAt: now })
      .where(eq(missions.id, mission.id))
      .returning();

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'planner.emitted',
      payload: {
        strategy: 'llm',
        reasoning: parsed.reasoning,
        taskIds: insertRows.map((r) => r.id),
        taskCount: insertRows.length,
        dependencies: taskRows
          .filter((r) => (parsed.tasks[r._idx]?.dependsOnIndices?.length ?? 0) > 0)
          .map((r) => ({ taskId: r.id, dependsOn: (r as Record<string, unknown>).dependsOnIds })),
      },
      createdAt: now,
    });

    if (!updated) throw new PlannerError('mission update failed', 'MISSION_NOT_FOUND');
    return { mission: updated, taskCount: insertRows.length };
  });
}
```

- [ ] **Step 2: Wire LLM planner into runPlanner**

In `apps/web/src/lib/planner.ts`, add import at top:

```typescript
import { runLlmPlanner } from './llm-planner';
```

Replace the body of `runPlanner` (lines 38-96) to dispatch by strategy:

```typescript
export async function runPlanner(missionId: string): Promise<PlanResult> {
  // Check strategy before entering transaction
  const [peek] = await db
    .select({ strategy: missions.plannerStrategy })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  if (peek?.strategy === 'llm') {
    return runLlmPlanner(missionId);
  }

  // Rule-based planner (original)
  return db.transaction(async (tx) => {
    const [mission] = await tx
      .select()
      .from(missions)
      .where(eq(missions.id, missionId))
      .limit(1);

    if (!mission) throw new PlannerError('mission not found', 'MISSION_NOT_FOUND');
    if (mission.status !== 'draft') {
      throw new PlannerError(
        `mission is ${mission.status}; planner only runs on draft`,
        mission.status === 'planning' ? 'ALREADY_PLANNED' : 'WRONG_STATUS',
      );
    }
    const repos = mission.targetRepos ?? [];
    if (repos.length === 0) {
      throw new PlannerError('mission has no target repos', 'NO_TARGET_REPOS');
    }

    const now = new Date();
    const rows: NewTask[] = repos.map((repo) => ({
      id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      repo,
      baseBranch: 'main',
      status: 'queued',
      promptVars: { repo, base_branch: 'main' },
      createdAt: now,
      updatedAt: now,
    }));

    await tx.insert(tasks).values(rows);

    const [updated] = await tx
      .update(missions)
      .set({ status: 'planning', updatedAt: now })
      .where(eq(missions.id, mission.id))
      .returning();

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'planner.emitted',
      payload: {
        strategy: mission.plannerStrategy,
        taskIds: rows.map((r) => r.id),
        repoCount: repos.length,
      },
      createdAt: now,
    });

    if (!updated) {
      throw new PlannerError('mission update returned no rows', 'MISSION_NOT_FOUND');
    }

    return { mission: updated, taskCount: rows.length };
  });
}
```

- [ ] **Step 3: Enable LLM option in new-mission-form**

In `apps/web/src/app/missions/new/new-mission-form.tsx`, remove `disabled` from the LLM SelectItem (line 134):

```typescript
                <SelectItem value="llm">
                  LLM (AI decomposes goal into dependent tasks)
                </SelectItem>
```

- [ ] **Step 4: Add ANTHROPIC_API_KEY to web env**

In `apps/web/src/lib/env.ts`, the getter for `ANTHROPIC_API_KEY` already exists (line 31). No change needed.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/llm-planner.ts apps/web/src/lib/planner.ts apps/web/src/app/missions/new/new-mission-form.tsx
git commit -m "feat(web): LLM planner — AI decomposes goals into dependent task DAGs"
```

---

### Task 5: Dispatcher — respect DAG dependencies

**Files:**
- Modify: `apps/tick/src/dispatcher.ts:79-106`

- [ ] **Step 1: Update claimNextBatch to skip blocked tasks**

In `apps/tick/src/dispatcher.ts`, replace the `candidates` query (lines 90-94) with dependency-aware logic:

```typescript
  // Get all queued tasks for this mission
  const allQueued = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), eq(tasks.status, 'queued')))
    .limit(slots * 3); // over-fetch to account for blocked tasks
  if (allQueued.length === 0) return [];

  // Filter out tasks whose dependencies haven't merged yet
  const unblocked: string[] = [];
  for (const t of allQueued) {
    const depIds = (t.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) {
      unblocked.push(t.id);
      continue;
    }
    // Check if all dependencies are merged
    const [depCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(inArray(tasks.id, depIds), eq(tasks.status, 'merged')));
    if (Number(depCount?.count ?? 0) === depIds.length) {
      unblocked.push(t.id);
    }
  }

  const ids = unblocked.slice(0, slots);
  if (ids.length === 0) return [];
```

- [ ] **Step 2: Update dispatchOne to use custom_prompt from LLM planner**

In `apps/tick/src/dispatcher.ts`, in the `dispatchOne` function, after constructing `vars` (line 128), add:

```typescript
  // LLM planner stores a custom per-task prompt in promptVars.custom_prompt.
  // When present, use it as the goal instead of the mission-level goal.
  const taskGoal = (vars.custom_prompt as string) ?? mission.goal;
```

Then replace `mission.goal` with `taskGoal` in the prompt construction:

```typescript
  let prompt: string;
  if (skill) {
    const skillPrompt = renderPrompt(skill.promptTemplate, vars);
    const goalPrompt = renderPrompt(taskGoal, vars);
    prompt = `${skillPrompt}\n\n---\n\n${goalPrompt}`;
  } else {
    prompt = renderPrompt(taskGoal, vars);
  }
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter tick typecheck && pnpm --filter tick test`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add apps/tick/src/dispatcher.ts
git commit -m "feat(tick): dispatcher respects DAG dependencies — only dispatches when deps merged"
```

---

### Task 6: Reconciler — dependency failure cascade

**Files:**
- Modify: `apps/tick/src/reconciler.ts:40-67`
- Modify: `apps/tick/src/reconciler.test.ts`

- [ ] **Step 1: Write failing test for dependency cascade**

Add to `apps/tick/src/reconciler.test.ts`:

```typescript
import { DEPENDENCY_FAILED_STATUSES } from './reconciler';

describe('DEPENDENCY_FAILED_STATUSES', () => {
  it('includes failed', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('failed');
  });

  it('includes abandoned', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('abandoned');
  });

  it('has exactly 2 statuses', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter tick test -- src/reconciler.test.ts`
Expected: FAIL — DEPENDENCY_FAILED_STATUSES not exported

- [ ] **Step 3: Add dependency failure cascade to reconciler**

In `apps/tick/src/reconciler.ts`, add after the imports:

```typescript
export const DEPENDENCY_FAILED_STATUSES: TaskStatus[] = ['failed', 'abandoned'];
```

Add import for `isNotNull` and `inArray`:

```typescript
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
```

In `runReconciler`, add a new phase (0) before the stall check at line 44:

```typescript
  // (0) Cascade-fail queued tasks whose dependencies have failed/abandoned.
  let tasksCascadeFailed = 0;
  const blocked = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'queued'), isNotNull(tasks.dependsOnIds)));

  for (const task of blocked) {
    const depIds = (task.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) continue;

    const [failedDeps] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(inArray(tasks.id, depIds), inArray(tasks.status, DEPENDENCY_FAILED_STATUSES)));

    if (Number(failedDeps?.count ?? 0) > 0) {
      const now = new Date();
      await db
        .update(tasks)
        .set({
          status: 'failed',
          lastError: 'upstream dependency failed',
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'queued')));
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.dependency_failed',
        payload: { dependsOnIds: depIds },
        createdAt: now,
      });
      tasksCascadeFailed += 1;
      log.info({ taskId: task.id }, 'reconciler:dependency_failed');
    }
  }
```

Update the return type and value to include `tasksCascadeFailed`:

```typescript
export type ReconcileResult = {
  missionsChecked: number;
  missionsCompleted: number;
  tasksAbandoned: number;
  tasksCascadeFailed: number;
};
```

Return `tasksCascadeFailed` in the result.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter tick test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add apps/tick/src/reconciler.ts apps/tick/src/reconciler.test.ts
git commit -m "feat(tick): reconciler cascade-fails queued tasks when dependencies fail"
```

---

### Task 7: AGENTS.md fetcher + cache

**Files:**
- Create: `apps/tick/src/agents-md.ts`
- Create: `apps/tick/src/agents-md.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/tick/src/agents-md.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { truncateAgentsMd, AGENTS_MD_MAX_CHARS } from './agents-md';

describe('truncateAgentsMd', () => {
  it('returns content unchanged if under limit', () => {
    expect(truncateAgentsMd('short')).toBe('short');
  });

  it('truncates content over limit and appends notice', () => {
    const long = 'x'.repeat(AGENTS_MD_MAX_CHARS + 100);
    const result = truncateAgentsMd(long);
    expect(result.length).toBeLessThanOrEqual(AGENTS_MD_MAX_CHARS + 100); // notice adds some
    expect(result).toContain('[... truncated');
  });

  it('uses correct max chars constant', () => {
    expect(AGENTS_MD_MAX_CHARS).toBe(8000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter tick test -- src/agents-md.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agents-md fetcher**

Create `apps/tick/src/agents-md.ts`:

```typescript
import { Octokit } from '@octokit/rest';

import { env } from './env';

export const AGENTS_MD_MAX_CHARS = 8000;

const FILE_CANDIDATES = [
  'AGENTS.md',
  '.github/AGENTS.md',
  'CLAUDE.md',
  '.claude/AGENTS.md',
];

// Cache: key = "owner/repo:missionId", value = content or null
const cache = new Map<string, string | null>();

let octokit: Octokit | undefined;
function client(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) return new Octokit();
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

/**
 * Fetch the AGENTS.md (or CLAUDE.md) content for a repo.
 * Cached per repo+mission so we don't re-fetch for every task in the same mission.
 */
export async function fetchAgentsMd(
  repo: string,
  missionId: string,
): Promise<{ content: string | null; file: string | null; truncated: boolean }> {
  const cacheKey = `${repo}:${missionId}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return { content: cached, file: null, truncated: false };
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    cache.set(cacheKey, null);
    return { content: null, file: null, truncated: false };
  }

  const gh = client();

  for (const path of FILE_CANDIDATES) {
    try {
      const { data } = await gh.repos.getContent({ owner, repo: repoName, path });
      if ('content' in data && typeof data.content === 'string') {
        let content = Buffer.from(data.content, 'base64').toString('utf-8');
        let truncated = false;
        if (content.length > AGENTS_MD_MAX_CHARS) {
          content = truncateAgentsMd(content);
          truncated = true;
        }
        cache.set(cacheKey, content);
        return { content, file: path, truncated };
      }
    } catch {
      // 404 or 403 — try next candidate
      continue;
    }
  }

  cache.set(cacheKey, null);
  return { content: null, file: null, truncated: false };
}

export function truncateAgentsMd(content: string): string {
  if (content.length <= AGENTS_MD_MAX_CHARS) return content;
  return content.slice(0, AGENTS_MD_MAX_CHARS) + '\n\n[... truncated at 8000 chars. See full file in repo.]';
}

/** Clear cache entries for a mission (call when mission completes). */
export function clearAgentsMdCache(missionId: string): void {
  for (const key of cache.keys()) {
    if (key.endsWith(`:${missionId}`)) {
      cache.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter tick test -- src/agents-md.test.ts`
Expected: all 3 pass

- [ ] **Step 5: Commit**

```bash
git add apps/tick/src/agents-md.ts apps/tick/src/agents-md.test.ts
git commit -m "feat(tick): AGENTS.md fetcher with file resolution, caching, and truncation"
```

---

### Task 8: Wire AGENTS.md into dispatcher

**Files:**
- Modify: `apps/tick/src/dispatcher.ts:1-12,130-149`

- [ ] **Step 1: Import and use fetchAgentsMd in dispatcher**

Add import:

```typescript
import { fetchAgentsMd } from './agents-md';
```

In `dispatchOne`, after the skill lookup (line 122) and before prompt construction, add:

```typescript
  // Fetch AGENTS.md / CLAUDE.md for this repo
  const agentsMd = await fetchAgentsMd(task.repo, mission.id);
```

Restructure prompt assembly to: AGENTS.md → Skill → Goal → Memories:

```typescript
  const parts: string[] = [];

  if (agentsMd.content) {
    parts.push(agentsMd.content);
  }

  if (skill) {
    parts.push(renderPrompt(skill.promptTemplate, vars));
  }

  parts.push(renderPrompt(taskGoal, vars));

  if (memoryBlock) {
    parts.push(memoryBlock);
  }

  const prompt = parts.join('\n\n---\n\n');
```

Add `agentsMdFile` to the ledger event payload:

```typescript
    payload: {
      sessionId,
      agentId: mission.agentId,
      repo: task.repo,
      baseBranch: task.baseBranch,
      ...(skill ? { skillSlug: skill.slug, skillVersion: skill.version } : {}),
      ...(agentsMd.file ? { agentsMdFile: agentsMd.file, agentsMdTruncated: agentsMd.truncated } : {}),
    },
```

- [ ] **Step 2: Typecheck and test**

Run: `pnpm --filter tick typecheck && pnpm --filter tick test`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add apps/tick/src/dispatcher.ts
git commit -m "feat(tick): inject AGENTS.md/CLAUDE.md into agent prompt at dispatch"
```

---

### Task 9: AI Review subsystem

**Files:**
- Create: `apps/tick/src/ai-review.ts`
- Create: `apps/tick/src/ai-review.test.ts`

- [ ] **Step 1: Write failing tests for review prompt builder**

Create `apps/tick/src/ai-review.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildReviewPrompt, parseReviewResponse } from './ai-review';

describe('buildReviewPrompt', () => {
  it('includes the mission goal', () => {
    const prompt = buildReviewPrompt({ goal: 'bump lodash', diff: '+foo', summary: '' });
    expect(prompt).toContain('bump lodash');
  });

  it('includes the diff', () => {
    const prompt = buildReviewPrompt({ goal: 'fix', diff: '+added line', summary: '' });
    expect(prompt).toContain('+added line');
  });
});

describe('parseReviewResponse', () => {
  it('parses an approve response', () => {
    const result = parseReviewResponse('{"decision":"approve","feedback":"looks good"}');
    expect(result).toEqual({ decision: 'approve', feedback: 'looks good' });
  });

  it('parses a reject response', () => {
    const result = parseReviewResponse('{"decision":"reject","feedback":"missing tests"}');
    expect(result).toEqual({ decision: 'reject', feedback: 'missing tests' });
  });

  it('returns reject for unparseable response', () => {
    const result = parseReviewResponse('not json');
    expect(result.decision).toBe('reject');
    expect(result.feedback).toContain('unparseable');
  });

  it('returns reject for missing decision field', () => {
    const result = parseReviewResponse('{"feedback":"hi"}');
    expect(result.decision).toBe('reject');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter tick test -- src/ai-review.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AI review subsystem**

Create `apps/tick/src/ai-review.ts`:

```typescript
import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { getAdapter } from './adapters';
import { db } from './db';
import { env } from './env';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type AiReviewResult = {
  tasksReviewed: number;
  approved: number;
  rejected: number;
  escalated: number;
  errors: number;
};

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const AI_REVIEW_MAX_RETRIES = 3;

let octokit: Octokit | undefined;
function ghClient(): Octokit {
  if (!octokit) {
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

export async function runAiReview(log: Logger): Promise<AiReviewResult> {
  const awaiting = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'awaiting_ai_review'), isNotNull(tasks.prUrl)));

  let approved = 0;
  let rejected = 0;
  let escalated = 0;
  let errors = 0;

  for (const task of awaiting) {
    try {
      const outcome = await reviewOne(task, log);
      if (outcome === 'approved') approved += 1;
      else if (outcome === 'rejected') rejected += 1;
      else if (outcome === 'escalated') escalated += 1;
    } catch (err) {
      errors += 1;
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'ai_review:error',
      );
    }
  }

  return { tasksReviewed: awaiting.length, approved, rejected, escalated, errors };
}

type ReviewOutcome = 'approved' | 'rejected' | 'escalated';

async function reviewOne(task: Task, log: Logger): Promise<ReviewOutcome> {
  if (!task.prUrl || !env.ANTHROPIC_API_KEY) return 'approved'; // skip if no API key

  const m = PR_URL_RE.exec(task.prUrl);
  if (!m) return 'approved';
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return 'approved';

  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  if (!mission) return 'approved';

  // Fetch PR diff
  const gh = ghClient();
  const { data: pr } = await gh.pulls.get({
    owner,
    repo,
    pull_number: Number(pullStr),
    mediaType: { format: 'diff' },
  });
  const diff = typeof pr === 'string' ? pr : String(pr);

  // Call Claude directly (not an MA session)
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const prompt = buildReviewPrompt({ goal: mission.goal, diff: diff.slice(0, 50000), summary: '' });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  // Track token costs
  const tokenCost = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  if (tokenCost > 0) {
    await db
      .update(tasks)
      .set({ costTokens: task.costTokens + tokenCost, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const review = parseReviewResponse(text);
  const now = new Date();

  if (review.decision === 'approve') {
    await db
      .update(tasks)
      .set({ status: 'awaiting_review', updatedAt: now })
      .where(eq(tasks.id, task.id));
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'ai_review.approved',
      payload: { feedback: review.feedback, tokenCost },
      createdAt: now,
    });
    log.info({ taskId: task.id }, 'ai_review:approved');
    return 'approved';
  }

  // Rejected
  if (task.aiReviewRetryCount >= AI_REVIEW_MAX_RETRIES) {
    // Escalate to human
    await db
      .update(tasks)
      .set({ status: 'awaiting_review', lastError: `AI review rejected ${AI_REVIEW_MAX_RETRIES}x: ${review.feedback}`, updatedAt: now })
      .where(eq(tasks.id, task.id));
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'ai_review.escalated',
      payload: { feedback: review.feedback, retryCount: task.aiReviewRetryCount, tokenCost },
      createdAt: now,
    });
    log.info({ taskId: task.id }, 'ai_review:escalated');
    return 'escalated';
  }

  // Send feedback to agent and retry
  if (task.sessionId) {
    try {
      const adapter = getAdapter(mission.backend);
      await adapter.sendTurn(
        task.sessionId,
        `Code review feedback: ${review.feedback}\n\nPlease address these issues and push a fix.`,
      );
    } catch {
      // sendTurn failed — escalate to human
      await db
        .update(tasks)
        .set({ status: 'awaiting_review', updatedAt: now })
        .where(eq(tasks.id, task.id));
      return 'escalated';
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'awaiting_ci', // back to CI — agent will push fix, CI re-runs
      aiReviewRetryCount: task.aiReviewRetryCount + 1,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ai_review.rejected',
    payload: { feedback: review.feedback, retryCount: task.aiReviewRetryCount + 1, tokenCost },
    createdAt: now,
  });
  log.info({ taskId: task.id, retry: task.aiReviewRetryCount + 1 }, 'ai_review:rejected');
  return 'rejected';
}

export function buildReviewPrompt(opts: { goal: string; diff: string; summary: string }): string {
  return `You are reviewing a pull request opened by an automated coding agent.

## Mission goal
${opts.goal}

## PR diff
\`\`\`diff
${opts.diff}
\`\`\`

${opts.summary ? `## Agent activity summary\n${opts.summary}\n` : ''}
## Instructions
Evaluate whether this PR achieves the mission goal correctly and safely.

Respond with JSON only:
{"decision": "approve" or "reject", "feedback": "explanation"}

Approval criteria:
- The diff achieves what the mission goal asked for
- No obvious bugs, security issues, or regressions
- No unrelated changes or scope creep
Be pragmatic. Minor style issues are not grounds for rejection.`;
}

export function parseReviewResponse(text: string): { decision: 'approve' | 'reject'; feedback: string } {
  try {
    const parsed = JSON.parse(text) as { decision?: string; feedback?: string };
    if (parsed.decision === 'approve' || parsed.decision === 'reject') {
      return { decision: parsed.decision, feedback: parsed.feedback ?? '' };
    }
    return { decision: 'reject', feedback: `unparseable decision: ${parsed.decision}` };
  } catch {
    return { decision: 'reject', feedback: `unparseable AI response: ${text.slice(0, 100)}` };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter tick test -- src/ai-review.test.ts`
Expected: all 6 pass

- [ ] **Step 5: Commit**

```bash
git add apps/tick/src/ai-review.ts apps/tick/src/ai-review.test.ts
git commit -m "feat(tick): AI review gate — direct Claude API review of PR diffs"
```

---

### Task 10: Wire AI review into tick loop + CI poller

**Files:**
- Modify: `apps/tick/src/tick.ts`
- Modify: `apps/tick/src/ci.ts:209-226`

- [ ] **Step 1: Add runAiReview to tick loop**

In `apps/tick/src/tick.ts`, add import:

```typescript
import { runAiReview } from './ai-review';
```

Add to TickResult type:

```typescript
  aiReview: Awaited<ReturnType<typeof runAiReview>>;
```

Insert between CI poller and auto-merge:

```typescript
  const aiReview = await runAiReview(log).catch((err) => {
    log.error({ err: String(err) }, 'tick:ai_review_crashed');
    return { tasksReviewed: 0, approved: 0, rejected: 0, escalated: 0, errors: 1 };
  });
```

Add `aiReview` to the return object.

- [ ] **Step 2: Update CI poller to conditionally transition to awaiting_ai_review**

In `apps/tick/src/ci.ts`, the `transitionToReview` function (line 209) currently always transitions to `awaiting_review`. Update `checkOne` to look up the mission and decide:

Replace the two calls to `transitionToReview` (lines 95 and 138) with a helper that checks the mission's `aiReviewEnabled`:

After the `const gh = client()` line, add a mission lookup:

```typescript
  const [mission] = await db
    .select({ aiReviewEnabled: missions.aiReviewEnabled })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  const nextStatus = mission?.aiReviewEnabled ? 'awaiting_ai_review' : 'awaiting_review';
```

Then update `transitionToReview` to accept the target status:

```typescript
async function transitionToReview(
  task: Task,
  payload: Record<string, unknown>,
  targetStatus: 'awaiting_review' | 'awaiting_ai_review' = 'awaiting_review',
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: targetStatus, updatedAt: now })
    .where(eq(tasks.id, task.id));
```

Pass `nextStatus` to both call sites.

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter tick typecheck && pnpm --filter tick test`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add apps/tick/src/tick.ts apps/tick/src/ci.ts
git commit -m "feat(tick): wire AI review into tick loop, CI poller conditionally routes to it"
```

---

### Task 11: UI — AI review toggle + mission schema update

**Files:**
- Modify: `apps/web/src/app/missions/new/new-mission-form.tsx`
- Modify: `apps/web/src/lib/missions.ts`
- Modify: `apps/web/src/app/missions/new/actions.ts`

- [ ] **Step 1: Add aiReviewEnabled to mission creation schema**

In `apps/web/src/lib/missions.ts`, add to `createMissionSchema`:

```typescript
  aiReviewEnabled: z.coerce.boolean().default(false),
```

In `createMissionForUser`, add to the values object:

```typescript
    aiReviewEnabled: input.aiReviewEnabled ?? false,
```

In `apps/web/src/app/missions/new/actions.ts`, add to the raw object:

```typescript
    aiReviewEnabled: formData.get('aiReviewEnabled') === 'on',
```

- [ ] **Step 2: Add toggle to new mission form**

In `apps/web/src/app/missions/new/new-mission-form.tsx`, add after the concurrency cap section (before the closing `</CardContent>` of the Execution card):

```typescript
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="aiReviewEnabled"
              name="aiReviewEnabled"
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor="aiReviewEnabled">AI code review before merge</Label>
            <p className="text-xs text-muted-foreground">
              AI reviews each PR against the mission goal before auto-merge.
            </p>
          </div>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/missions.ts apps/web/src/app/missions/new/actions.ts apps/web/src/app/missions/new/new-mission-form.tsx
git commit -m "feat(web): AI review toggle in new mission form"
```

---

### Task 12: Write AGENTS.md for Forge itself

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: Write the file**

Create `AGENTS.md` at repo root:

```markdown
# Forge — Agent Context

## Project structure

Monorepo managed by pnpm workspaces:

- `packages/db` — Drizzle ORM schema + migrations for libSQL/Turso. Source of truth for all types.
- `apps/tick` — Fastify service invoked by Cloud Scheduler every 60s. Runs: poller, CI poller, AI review, auto-merge, budgets, reconciler, dispatcher, memory expiry.
- `apps/web` — Next.js App Router console + REST API + better-auth authentication.
- `skills/` — Curated skill definitions (SKILL.md + tools.json per skill).
- `prompts/` — System prompts for retrospective and other agent sessions.

## Tech stack

- **Runtime:** Node 22, TypeScript strict everywhere
- **DB:** Drizzle ORM over libSQL (local SQLite for dev, Turso for prod)
- **Tick service:** Fastify, no framework beyond that
- **Web:** Next.js 15 App Router, Tailwind CSS, shadcn/ui components
- **Auth:** better-auth with email+password
- **Testing:** vitest, no mocking frameworks — extract pure functions and test those
- **Package manager:** pnpm with workspace protocol

## Conventions

- Conventional commits: `feat(scope):`, `fix(scope):`, `test(scope):`, `docs:`
- One feature per PR. Keep PRs focused.
- All exports from `packages/db` are re-exported via `src/index.ts`.
- Tick subsystems are independent async functions that receive a logger and return a typed result.
- Web API routes use `apiAuth()` for authentication (returns 401 tuple).
- Server components use `withAuth()` (redirects to /login).
- Tasks use vitest with `vitest.setup.ts` that stubs env vars. Tests exercise pure/exported functions — no DB mocking.

## Testing

- Run: `pnpm --filter tick test` and `pnpm --filter web test`
- Typecheck: `pnpm --filter <pkg> typecheck`
- Extract pure functions for testability rather than mocking dependencies.
- Test files live next to source: `foo.ts` → `foo.test.ts`

## Key patterns

- **Tick loop** (`apps/tick/src/tick.ts`): ordered subsystems, each wrapped in `.catch()` so one crash doesn't cascade.
- **Ledger events**: every state change inserts a `ledgerEvents` row. Events are the audit trail.
- **Adapter pattern** (`apps/tick/src/adapters/`): `BackendAdapter` interface with MA and Gateway implementations.
- **Status-driven queries**: each subsystem queries tasks by status. Adding a new status means updating INFLIGHT_STATUSES, ALL_TASK_STATUSES, and the task-status-badge component.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md — repo context for autonomous coding agents"
```

---

### Task 13: Final verification

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter db typecheck && pnpm --filter tick typecheck && pnpm --filter web typecheck`
Expected: all clean

- [ ] **Step 2: Full test suite**

Run: `pnpm --filter tick test && pnpm --filter web test`
Expected: all pass (should be ~140+ tests)

- [ ] **Step 3: Commit any fixups**

If any tests or types broke, fix and commit.
