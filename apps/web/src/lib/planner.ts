import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type NewTask } from '@forge/db';

import { db } from './db';
import { runLlmPlanner } from './llm-planner';

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MISSION_NOT_FOUND'
      | 'WRONG_STATUS'
      | 'NO_TARGET_REPOS'
      | 'ALREADY_PLANNED',
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}

export type PlanResult = {
  mission: Mission;
  taskCount: number;
};

/**
 * Rule-based Planner (v1, PRD §7.3):
 *   one Task per target repo, prompt is the Mission's goal template with
 *   {{repo}} and {{base_branch}} substituted. Task status starts as
 *   'queued'; the dispatcher picks them up in a later phase.
 *
 * Idempotency: only runnable when the Mission is in status='draft'. Runs
 * exactly once — transitioning the Mission to 'planning' and writing a
 * single ledger event ('planner.emitted') capturing the Task IDs.
 */
export async function runPlanner(missionId: string): Promise<PlanResult> {
  // Peek at the strategy before committing to a path.
  const [peek] = await db
    .select({ plannerStrategy: missions.plannerStrategy })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  if (peek?.plannerStrategy === 'llm') {
    return runLlmPlanner(missionId);
  }

  // Rule-based (default) path.
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

/** Rendered prompt for a Task — template substitution from the Mission goal. */
export function renderPrompt(goal: string, vars: Record<string, unknown>): string {
  return goal.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
