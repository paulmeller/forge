import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Backend, type Task, type TaskStatus } from '@forge/db';

import { getAdapter } from '@/server/tick/adapters';

import { db } from './db';
import { getTask } from './tasks';

/**
 * `code` lets callers dispatch on the *kind* of failure without comparing
 * `error` message strings (which are meant for humans/logs and can change
 * wording without notice — see `reviewTask`'s `ReviewOutcome` for the
 * pattern this mirrors). `UPSTREAM_FAILURE` covers adapter/network errors
 * reaching the mission's backend (a running session couldn't be cancelled
 * or reached) — distinct from `INVALID_STATE`, because "the backend is
 * unreachable right now" is retryable and "the task isn't in a state this
 * operation applies to" is not; collapsing them denies the caller that
 * distinction.
 *
 * The success branch carries the post-mutation `task` row directly (read
 * back via the same `.returning()` the write already does, or the
 * unmodified row when nothing needed updating) so callers never have to
 * re-fetch — and can never accidentally serialise a null "success" body.
 */
export type TaskOpResult =
  | { ok: true; task: Task }
  | { ok: false; code: 'NOT_FOUND' | 'INVALID_STATE' | 'UPSTREAM_FAILURE'; error: string };

// Terminal Task statuses (mirrors apps/tick/src/reconciler.ts's
// MISSION_TERMINAL_TASK_STATUSES, minus 'needs_human' which is
// mission-terminal but not Task-terminal — no cross-app import needed for
// this small a check).
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['merged', 'resolved', 'abandoned', 'failed'];

// The steer message length cap. Lives HERE, not only in the route's Zod
// schema (lib/api/schemas.ts's `tasks.steer.body`), because the Server
// Action path (steerTask -> steerTaskForUser, repos/[owner]/[repo]/
// actions.ts) never touches that schema at all — a route-only cap
// constrains one transport and leaves the other unbounded, which is
// exactly the drift this whole extraction was meant to eliminate. The
// schema keeps its own copy of this same number (for the generated OpenAPI
// spec, and to reject oversized bodies before they're even parsed here),
// but this is the enforcement both callers actually get.
const STEER_MESSAGE_MAX_LENGTH = 10_000;

/**
 * Backend for a mission the caller has already been proven to own (via
 * `getTask`'s ownership-scoped join). Deliberately NOT `getMission(id,
 * userId)`: that would be a second, independent ownership check on a
 * different id, and its own null-on-mismatch would 404 a broken
 * `getTask` for the wrong reason — proving mission ownership, not task
 * ownership, and silently masking a dropped `userId` filter on `getTask`
 * itself. This is a plain, unscoped lookup on purpose.
 */
async function missionBackend(missionId: string): Promise<Backend | null> {
  const [row] = await db
    .select({ backend: missions.backend })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  return row?.backend ?? null;
}

/**
 * Abort a running Task's session. Only meaningful for a Task with an active
 * session (running/dispatching/etc.) — marks it failed with haltReason
 * 'manual_abort', mirroring the shape budgets.ts's hardStop already uses for
 * the same kind of forced stop.
 *
 * Shared by the `abortTask` Server Action (repos/[owner]/[repo]/actions.ts)
 * and the `/api/v1` abort route. `getTask(taskId, userId)` is
 * ownership-scoped — a task belonging to another account and a nonexistent
 * task are indistinguishable — so both callers must resolve the caller's
 * identity first (withAuth() / withApiAuth()) and pass it in as `userId`.
 */
export async function abortTaskForUser(taskId: string, userId: string): Promise<TaskOpResult> {
  const task = await getTask(taskId, userId);
  if (!task) return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };
  if (!task.sessionId) {
    return { ok: false, code: 'INVALID_STATE', error: 'Task has no active session to abort' };
  }
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, code: 'INVALID_STATE', error: 'Task has already finished, nothing to abort' };
  }

  const backend = await missionBackend(task.missionId);
  if (!backend) return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };

  try {
    // Route through the mission's own backend rather than assuming
    // managed-agents: a Gemini mission's session lives behind a different API
    // entirely, and backendSessionRef is the handle that survives a restart.
    await getAdapter(backend).cancelSession(task.sessionId, task.backendSessionRef);
  } catch (err) {
    return {
      ok: false,
      code: 'UPSTREAM_FAILURE',
      error: `Could not cancel session: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  const now = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const row = await tx
      .update(tasks)
      .set({
        status: 'failed',
        haltReason: 'manual_abort',
        lastError: 'Aborted by operator',
        // TERMINAL_TASK_STATUSES above deliberately excludes ready_to_merge,
        // needs_human and merging, so an operator can abort a Task sitting
        // in any of those — and any of them can carry a human approvedBy
        // (needs_human can also carry an escalationReason). Neither
        // describes the abort outcome, so both must be cleared here exactly
        // like every other place a Task is forced out of the state an
        // approval covered.
        approvedBy: null,
        escalationReason: null,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .returning();

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.aborted',
      payload: { sessionId: task.sessionId },
      createdAt: now,
    });

    return row;
  });

  if (!updated) {
    // The row `getTask` just proved existed vanished between that read and
    // this write. Nothing in this app deletes a Task row today, so this is
    // not a path any test can currently reach — but if it ever happens,
    // report it plainly rather than letting the caller serialise a 200
    // whose body is null (Finding 6).
    return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };
  }

  return { ok: true, task: updated };
}

/**
 * Send a mid-run instruction into a Task's live session. The message is
 * appended to the session's event stream (same `user.message` shape the
 * dispatcher uses for the opening turn) and recorded in the audit ledger.
 *
 * Shared by the `steerTask` Server Action (repos/[owner]/[repo]/actions.ts)
 * and the `/api/v1` steer route — see `abortTaskForUser`'s doc comment for
 * the ownership rationale, identical here.
 */
export async function steerTaskForUser(
  taskId: string,
  userId: string,
  message: string,
): Promise<TaskOpResult> {
  const text = message.trim();
  if (!text) return { ok: false, code: 'INVALID_STATE', error: 'Message is empty' };
  if (text.length > STEER_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      error: `Message is too long (max ${STEER_MESSAGE_MAX_LENGTH} characters)`,
    };
  }

  const task = await getTask(taskId, userId);
  if (!task) return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };
  if (!task.sessionId) {
    return { ok: false, code: 'INVALID_STATE', error: 'Task has no active session to steer' };
  }
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, code: 'INVALID_STATE', error: 'Task has already finished, nothing to steer' };
  }

  const backend = await missionBackend(task.missionId);
  if (!backend) return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };

  // Defaults to the pre-mutation row: sendTurn doesn't always rotate the
  // session handle, and when it doesn't, nothing about the Task row itself
  // changed — there's no second read to do, and none is needed for `ok`'s
  // response body to reflect reality.
  let updatedTask: Task = task;
  try {
    // Route through the mission's own backend, not a hardcoded Anthropic
    // client. Like the tick engine's other sendTurn call sites, a backend that
    // rotates its session handle (Gemini) returns a new ref we must persist,
    // or a later cancel/poll would target the stale one.
    const result = await getAdapter(backend).sendTurn({
      sessionId: task.sessionId,
      text,
      backendSessionRef: task.backendSessionRef,
    });
    if (result.backendSessionRef) {
      const [row] = await db
        .update(tasks)
        .set({ backendSessionRef: result.backendSessionRef, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      if (row) updatedTask = row;
    }
  } catch (err) {
    return {
      ok: false,
      code: 'UPSTREAM_FAILURE',
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

  return { ok: true, task: updatedTask };
}
