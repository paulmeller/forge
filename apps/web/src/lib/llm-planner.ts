import { randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { eq } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { ledgerEvents, missions, tasks, type NewTask } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { PlannerError, type PlanResult } from './planner';

// ---------------------------------------------------------------------------
// Inlined DAG validation (mirrors apps/tick/src/dag.ts — pure function, no
// cross-package import needed).
// ---------------------------------------------------------------------------

type TaskNode = {
  index: number;
  dependsOnIndices: number[];
};

type DagResult = { valid: true; error: null } | { valid: false; error: string };

function validateDag(nodes: TaskNode[]): DagResult {
  const n = nodes.length;

  for (const task of nodes) {
    for (const dep of task.dependsOnIndices) {
      if (dep < 0 || dep >= n) {
        return {
          valid: false,
          error: `task ${task.index} depends on index ${dep} which is out of bounds (0-${n - 1})`,
        };
      }
    }
  }

  const adj = new Map<number, number[]>();
  for (const task of nodes) {
    adj.set(task.index, task.dependsOnIndices);
  }

  // 0 = unvisited, 1 = visiting (in current DFS path), 2 = done
  const state = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (state[i] === 2) continue;
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
        return {
          valid: false,
          error: `cycle detected involving task indices ${child} and ${frame.node}`,
        };
      }
      if (state[child] === 0) {
        state[child] = 1;
        stack.push({ node: child, childIdx: 0 });
      }
    }
  }

  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

export type LlmTask = {
  repo: string;
  label: string;
  prompt: string;
  dependsOnIndices: number[];
};

export type LlmPlanResponse = {
  reasoning: string;
  tasks: LlmTask[];
};

const LlmPlanSchema = z.object({
  reasoning: z.string(),
  tasks: z.array(
    z.object({
      repo: z.string(),
      label: z.string(),
      prompt: z.string(),
      dependsOnIndices: z.array(z.number()),
    }),
  ),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a software-engineering planning assistant for the Forge orchestration platform.
Your job is to decompose a high-level goal into a concrete set of agent tasks, each targeting one repository.

You MUST respond with valid JSON and nothing else — no markdown fences, no commentary outside the JSON.
The JSON must conform exactly to this schema:

{
  "reasoning": "<brief description of your decomposition strategy>",
  "tasks": [
    {
      "repo": "<owner/repo — must come from the allowed repos list>",
      "label": "<short human-readable label, ≤60 chars>",
      "prompt": "<self-contained instructions for the coding agent>",
      "dependsOnIndices": [<0-based indices of tasks this one depends on>]
    }
  ]
}

Rules:
- Each task must target exactly one repo from the allowed list.
- Maximum 20 tasks total.
- Prompts must be self-contained — the agent sees only the prompt, not the goal or other tasks.
- Prefer independent tasks (empty dependsOnIndices) wherever possible.
- dependsOnIndices must never create a cycle.
- Use 0-based indices into the tasks array.
- Do not add repos that are not in the allowed list.`;

// ---------------------------------------------------------------------------
// Exported function: requestPlan
// ---------------------------------------------------------------------------

/**
 * Ask the model to decompose a goal into per-repo tasks. Re-throws the same
 * error message shape as before on a malformed response — deliberately not
 * relying on generateObject's internal retry, so a bad response stays a
 * visible, immediate failure rather than a silent retry.
 */
export async function requestPlan(opts: {
  goal: string;
  repos: string[];
}): Promise<LlmPlanResponse> {
  const userMessage = `Goal: ${opts.goal || '(no goal provided)'}

Allowed repositories (you must only use repos from this list):
${opts.repos.map((r) => `  - ${r}`).join('\n')}

Decompose this goal into agent tasks.`;

  try {
    const { object } = await generateObject({
      model: anthropic('claude-sonnet-4-6'),
      schema: LlmPlanSchema,
      instructions: SYSTEM_PROMPT,
      prompt: userMessage,
    });
    return object;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new Error(
        `LLM planner: failed to parse Claude response as JSON: ${(error.text ?? '').slice(0, 200)}`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runLlmPlanner(missionId: string): Promise<PlanResult> {
  // 1. Look up the mission (outside the transaction — we need it before the
  //    Anthropic call, and we don't want to hold a DB connection during I/O).
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

  // 2. Ask the model to decompose the goal into tasks.
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; cannot run LLM planner');
  }

  const plan = await requestPlan({ goal: mission.goal ?? '', repos });

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('LLM planner: Claude returned no tasks');
  }
  if (plan.tasks.length > 20) {
    throw new Error(`LLM planner: Claude returned ${plan.tasks.length} tasks (max 20)`);
  }

  // Validate that all repos are in the allowed list.
  const repoSet = new Set(repos);
  for (const [i, task] of plan.tasks.entries()) {
    if (!repoSet.has(task.repo)) {
      throw new Error(
        `LLM planner: task ${i} references repo "${task.repo}" which is not in the allowed list`,
      );
    }
  }

  // 4. Validate the DAG is acyclic.
  const dagNodes: TaskNode[] = plan.tasks.map((t, i) => ({
    index: i,
    dependsOnIndices: Array.isArray(t.dependsOnIndices) ? t.dependsOnIndices : [],
  }));

  const dagResult = validateDag(dagNodes);
  if (!dagResult.valid) {
    throw new Error(`LLM planner: invalid DAG — ${dagResult.error}`);
  }

  // 5. DB transaction: insert tasks (resolving index-based deps to real IDs),
  //    transition mission to 'planning', and write a ledger event.
  return db.transaction(async (tx) => {
    // Re-check mission status inside the transaction for safety.
    const [current] = await tx
      .select()
      .from(missions)
      .where(eq(missions.id, missionId))
      .limit(1);

    if (!current) throw new PlannerError('mission not found', 'MISSION_NOT_FOUND');
    if (current.status !== 'draft') {
      throw new PlannerError(
        `mission is ${current.status}; planner only runs on draft`,
        current.status === 'planning' ? 'ALREADY_PLANNED' : 'WRONG_STATUS',
      );
    }

    const now = new Date();

    // Pre-generate all task IDs so we can resolve dependsOnIndices → IDs.
    const taskIds: string[] = plan.tasks.map(
      () => `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    );

    const rows: NewTask[] = plan.tasks.map((t, i) => ({
      id: taskIds[i]!,
      missionId: current.id,
      repo: t.repo,
      baseBranch: 'main',
      status: 'queued',
      promptVars: {
        repo: t.repo,
        base_branch: 'main',
        label: t.label,
        // Key must be `custom_prompt` — that's what the dispatcher reads to
        // override the mission goal per Task (dispatcher.ts). Writing `prompt`
        // silently fell back to mission.goal for every LLM-planned Task.
        custom_prompt: t.prompt,
      },
      dependsOnIds:
        t.dependsOnIndices.length > 0
          ? t.dependsOnIndices.map((idx) => taskIds[idx]!)
          : null,
      createdAt: now,
      updatedAt: now,
    }));

    await tx.insert(tasks).values(rows);

    const [updated] = await tx
      .update(missions)
      .set({ status: 'planning', updatedAt: now })
      .where(eq(missions.id, current.id))
      .returning();

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: current.id,
      eventType: 'planner.emitted',
      payload: {
        strategy: 'llm',
        reasoning: plan.reasoning,
        taskIds,
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
