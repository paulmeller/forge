import { randomUUID } from 'node:crypto';

import { and, eq } from '@forge/db/orm';

import { ledgerEvents, tasks, type Task } from '@forge/db';

import { db } from './db';
import { getTask } from './tasks';
import { PR_URL_RE, client as getOctokit } from '@/server/tick/auto-merge';

export type ReviewOperation = 'approve' | 'dismiss';

export type ReviewOutcome =
  | { ok: true; task: Task }
  | { ok: false; code: 'NOT_FOUND' | 'INVALID_STATE'; error: string };

/**
 * I5: the PR's current head SHA at the moment Approve happens, so the
 * approval can be scoped to the diff a human actually looked at rather than
 * to the Task id forever (see `approvedHeadSha` on schema.ts's `tasks`
 * table and the `AutoMergePolicy.requireHumanApproval` doc comment).
 *
 * Best-effort: if the PR URL doesn't parse or GitHub can't be reached right
 * now, this returns null rather than failing the approval outright. `null`
 * is not treated as "any SHA is fine" — auto-merge.ts's `tryMerge` requires
 * an exact match against the PR's live head SHA, so a null here just means
 * the next auto-merge pass blocks with a clear reason instead of trusting an
 * approval it can't verify.
 */
async function currentPrHeadSha(prUrl: string | null): Promise<string | null> {
  if (!prUrl) return null;
  const m = PR_URL_RE.exec(prUrl);
  if (!m) return null;
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return null;
  try {
    const { data: pr } = await getOctokit().pulls.get({
      owner,
      repo,
      pull_number: Number(pullStr),
    });
    return pr.head.sha;
  } catch {
    return null;
  }
}

/**
 * Clears a Task out of `needs_human` — the exit the review queue never had.
 * Shared by the `reviewAction` Server Action (missions/[missionId]/tasks/
 * [taskId]/review-actions.ts) and the `/api/v1` approve/dismiss routes, so
 * the auth-ownership-CAS behaviour cannot drift between the two transports.
 *
 * Callers must resolve the caller's identity themselves (Server Action via
 * withAuth(), API route via withApiAuth()) and pass it in as `userId` —
 * this function only takes it from there. `getTask(taskId, userId)` is
 * ownership-scoped, so a task belonging to another account and a
 * nonexistent task are indistinguishable (`NOT_FOUND` for both); approving
 * another account's Task would otherwise be a one-request privilege
 * escalation into their auto-merge pipeline.
 *
 * The write itself is additionally guarded by a compare-and-swap on
 * `status = 'needs_human'` (same pattern as the tick engine in
 * server/tick/*.ts) so a task that raced its way out of the queue between
 * the read and the write is never clobbered.
 */
export async function reviewTask(
  taskId: string,
  userId: string,
  operation: ReviewOperation,
): Promise<ReviewOutcome> {
  const task = await getTask(taskId, userId);
  if (!task) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  if (task.status !== 'needs_human') {
    return {
      ok: false,
      code: 'INVALID_STATE',
      error: `task is ${task.status}, not awaiting a human`,
    };
  }

  const now = new Date();
  const approvedHeadSha = operation === 'approve' ? await currentPrHeadSha(task.prUrl) : null;
  const [updated] =
    operation === 'approve'
      ? await db
          .update(tasks)
          .set({
            status: 'ready_to_merge',
            escalationReason: null,
            approvedBy: userId,
            approvedHeadSha,
            lastError: null,
            updatedAt: now,
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'needs_human')))
          .returning()
      : await db
          .update(tasks)
          .set({
            status: 'abandoned',
            // A dismissed Task is dead work — any prior approval was for a
            // diff that never merged. Clearing it here is what stops a
            // retryMission'd re-run of THIS task from inheriting yesterday's
            // approval and sailing straight through requireHumanApproval on
            // a PR nobody has looked at (see mission-transitions.ts).
            approvedBy: null,
            approvedHeadSha: null,
            // Also stale the moment the task is dismissed: the reason it was
            // escalated described the needs_human row, not a dead abandoned
            // one.
            escalationReason: null,
            updatedAt: now,
            completedAt: now,
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'needs_human')))
          .returning();

  if (!updated) {
    // Lost the race — someone/something else already moved this Task out of
    // needs_human between our read and our write. Safe no-op, not an error
    // that would suggest the caller should retry and clobber it.
    return { ok: false, code: 'INVALID_STATE', error: `task is no longer awaiting a human` };
  }

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: operation === 'approve' ? 'review.approved' : 'review.dismissed',
    payload: { by: userId, previousEscalationReason: task.escalationReason },
    createdAt: now,
  });

  return { ok: true, task: updated };
}
