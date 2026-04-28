import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type Task } from '@forge/db';

import { db } from './db';

export class TaskEditError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MISSION_NOT_FOUND'
      | 'TASK_NOT_FOUND'
      | 'WRONG_MISSION_STATUS'
      | 'WRONG_TASK_STATUS'
      | 'INVALID_REPO',
  ) {
    super(message);
    this.name = 'TaskEditError';
  }
}

const repoSlugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

async function loadMission(missionId: string): Promise<Mission> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!m) throw new TaskEditError('mission not found', 'MISSION_NOT_FOUND');
  if (m.status !== 'planning') {
    throw new TaskEditError(
      `mission status is ${m.status}; tasks editable only during planning`,
      'WRONG_MISSION_STATUS',
    );
  }
  return m;
}

export async function addTask(
  missionId: string,
  input: { repo: string; baseBranch?: string },
): Promise<Task> {
  const mission = await loadMission(missionId);
  if (!repoSlugPattern.test(input.repo)) {
    throw new TaskEditError('repo must be "owner/repo"', 'INVALID_REPO');
  }
  const baseBranch = input.baseBranch?.trim() || 'main';
  const now = new Date();
  const [created] = await db
    .insert(tasks)
    .values({
      id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      repo: input.repo,
      baseBranch,
      status: 'queued',
      promptVars: { repo: input.repo, base_branch: baseBranch },
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) throw new TaskEditError('insert returned no rows', 'TASK_NOT_FOUND');

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    taskId: created.id,
    eventType: 'planner.task_added',
    payload: { repo: input.repo, baseBranch, addedManually: true },
    createdAt: now,
  });
  return created;
}

export async function updateTaskPromptVars(
  missionId: string,
  taskId: string,
  promptVars: Record<string, unknown>,
): Promise<Task> {
  const mission = await loadMission(missionId);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.missionId, mission.id)))
    .limit(1);
  if (!task) throw new TaskEditError('task not found in mission', 'TASK_NOT_FOUND');
  if (task.status !== 'queued') {
    throw new TaskEditError(
      `task status is ${task.status}; only queued tasks can be edited`,
      'WRONG_TASK_STATUS',
    );
  }
  const now = new Date();
  const [updated] = await db
    .update(tasks)
    .set({ promptVars, updatedAt: now })
    .where(eq(tasks.id, taskId))
    .returning();
  if (!updated) throw new TaskEditError('update returned no rows', 'TASK_NOT_FOUND');
  return updated;
}

export async function removeTask(missionId: string, taskId: string): Promise<void> {
  const mission = await loadMission(missionId);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.missionId, mission.id)))
    .limit(1);
  if (!task) throw new TaskEditError('task not found in mission', 'TASK_NOT_FOUND');
  if (task.status !== 'queued') {
    throw new TaskEditError(
      `task status is ${task.status}; only queued tasks can be removed`,
      'WRONG_TASK_STATUS',
    );
  }
  const now = new Date();
  // Soft remove via cascade-clean-friendly hard delete (only safe because
  // mission is still planning so no dispatcher has touched the task).
  await db.delete(tasks).where(eq(tasks.id, taskId));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'planner.task_removed',
    payload: { taskId, repo: task.repo },
    createdAt: now,
  });
}
