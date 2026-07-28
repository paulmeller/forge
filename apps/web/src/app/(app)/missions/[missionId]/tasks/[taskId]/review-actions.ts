'use server';

import { revalidatePath } from 'next/cache';

import { reviewTask } from '@/lib/task-review';
import { withAuth } from '@/lib/with-auth';

export type ReviewActionState = { error?: string; ok?: boolean };

/**
 * Thin transport over `reviewTask` (lib/task-review.ts) — the actual
 * auth-ownership-CAS logic lives there and is shared with the `/api/v1`
 * approve/dismiss routes so the two transports cannot drift. This wrapper
 * only does what's specific to being a form action: pulling fields out of
 * FormData, resolving the caller via withAuth(), and revalidating the page
 * that rendered the form.
 */
export async function reviewAction(formData: FormData): Promise<ReviewActionState> {
  const user = await withAuth();

  const taskId = formData.get('taskId');
  const op = formData.get('op');
  if (typeof taskId !== 'string') return { error: 'missing taskId' };
  if (op !== 'approve' && op !== 'dismiss') return { error: 'invalid op' };

  const result = await reviewTask(taskId, user.id, op);
  if (!result.ok) return { error: result.error };

  revalidatePath(`/missions/${result.task.missionId}/tasks/${result.task.id}`);
  return { ok: true };
}
