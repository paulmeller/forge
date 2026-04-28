import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type Mission,
  type TaskStatus,
} from '@forge/db';

import { db } from './db';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type ReconcileResult = {
  missionsChecked: number;
  missionsCompleted: number;
  tasksAbandoned: number;
  tasksCascadeFailed: number;
};

export const DEPENDENCY_FAILED_STATUSES: TaskStatus[] = ['failed', 'abandoned'];

const MISSION_TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'merged',
  'awaiting_review',
  'abandoned',
  'failed',
];

/**
 * Close out Missions whose Tasks have all settled, and clean up Tasks that
 * stalled in turn_ended with no PR (agent produced no diff — PRD §7.5).
 *
 * Called by the tick after the poller so fresh state transitions from this
 * tick feed into the completion check.
 */
export async function runReconciler(log: Logger): Promise<ReconcileResult> {
  let tasksAbandoned = 0;
  let missionsCompleted = 0;

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

  // (1) Stalled turn_ended → abandoned. Require the task to have a session
  // but no PR URL — that's the "agent finished without opening a PR" shape.
  const stalled = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'turn_ended'), isNull(tasks.prUrl)));

  for (const task of stalled) {
    const now = new Date();
    await db
      .update(tasks)
      .set({ status: 'abandoned', updatedAt: now, completedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')));
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.abandoned',
      payload: { reason: 'turn_ended with no PR captured' },
      createdAt: now,
    });
    tasksAbandoned += 1;
    log.info({ taskId: task.id }, 'reconciler:task_abandoned');
  }

  // (2) Complete Missions whose tasks are all in terminal states.
  const candidates = await db
    .select()
    .from(missions)
    .where(eq(missions.status, 'running'));

  for (const mission of candidates) {
    const nonTerminal = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.missionId, mission.id),
          notInArray(tasks.status, MISSION_TERMINAL_TASK_STATUSES),
        ),
      );
    const remaining = Number(nonTerminal[0]?.count ?? 0);
    if (remaining > 0) continue;

    const anyTasks = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.missionId, mission.id));
    if (Number(anyTasks[0]?.count ?? 0) === 0) continue; // Mission with zero tasks — leave alone

    await completeMission(mission);
    missionsCompleted += 1;
    log.info({ missionId: mission.id }, 'reconciler:mission_completed');
  }

  return { missionsChecked: candidates.length, missionsCompleted, tasksAbandoned, tasksCascadeFailed };
}

async function completeMission(mission: Mission): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(missions.id, mission.id), eq(missions.status, 'running')))
    .returning();
  if (!updated) return; // lost the race; fine

  const [counts] = await db
    .select({
      merged: sql<number>`sum(case when ${tasks.status} = 'merged' then 1 else 0 end)`,
      awaitingReview: sql<number>`sum(case when ${tasks.status} = 'awaiting_review' then 1 else 0 end)`,
      abandoned: sql<number>`sum(case when ${tasks.status} = 'abandoned' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${tasks.status} = 'failed' then 1 else 0 end)`,
    })
    .from(tasks)
    .where(eq(tasks.missionId, mission.id));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'mission.completed',
    payload: {
      merged: Number(counts?.merged ?? 0),
      awaitingReview: Number(counts?.awaitingReview ?? 0),
      abandoned: Number(counts?.abandoned ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    createdAt: now,
  });
}

// Re-exported for test visibility.
export { MISSION_TERMINAL_TASK_STATUSES }; // DEPENDENCY_FAILED_STATUSES is already exported above
