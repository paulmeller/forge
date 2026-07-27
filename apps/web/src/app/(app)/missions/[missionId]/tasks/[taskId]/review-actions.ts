'use server';

import { randomUUID } from 'node:crypto';

import { and, eq } from '@forge/db/orm';
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
 * their auto-merge pipeline. The write itself is additionally guarded by a
 * compare-and-swap on `status = 'needs_human'` (same pattern as the tick
 * engine in server/tick/*.ts) so a task that raced its way out of the queue
 * between the read and the write is never clobbered.
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
  const [updated] =
    operation === 'approve'
      ? await db
          .update(tasks)
          .set({
            status: 'ready_to_merge',
            escalationReason: null,
            approvedBy: user.id,
            lastError: null,
            updatedAt: now,
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'needs_human')))
          .returning()
      : await db
          .update(tasks)
          .set({ status: 'abandoned', updatedAt: now, completedAt: now })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'needs_human')))
          .returning();

  if (!updated) {
    // Lost the race — someone/something else already moved this Task out of
    // needs_human between our read and our write. Safe no-op, not an error
    // that would suggest the caller should retry and clobber it.
    return { error: `task is no longer awaiting a human` };
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
