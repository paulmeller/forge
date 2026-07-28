import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { toTaskResponse } from '@/lib/api/dto';
import { fail, notFound, ok } from '@/lib/api/respond';
import { schemas } from '@/lib/api/schemas';
import { steerTaskForUser } from '@/lib/task-session-ops';
import { getTask } from '@/lib/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, req, { params }) => {
    const { missionId, taskId } = await params;

    // Ownership is checked twice on this path — here, and again inside
    // steerTaskForUser, which repeats getTask(taskId, user.id) so the Server
    // Action transport is gated too. Same function, same predicate, same id,
    // so neither hides a break in the other; see the approve route's doc
    // comment for why that is benign while a second check on a DIFFERENT id
    // (getMission(missionId, user.id)) would not be. This call is also what
    // the missionId path-consistency check below compares against: the URL's
    // missionId is matched to the already-ownership-proven task's own
    // missionId column, never re-queried.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'Invalid JSON body', 400);
    }

    let message: string;
    try {
      ({ message } = schemas['tasks.steer'].body.parse(body));
    } catch (err) {
      if (err instanceof ZodError) {
        return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
      }
      throw err;
    }

    const result = await steerTaskForUser(taskId, user.id, message);
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound('Task');
      // Adapter/network failure reaching the mission's backend — retryable,
      // and not the caller's fault, so it must not look like a 409 (that
      // says "your request conflicts with the resource's state", which is
      // false here). See Finding 4 of the Task 5 review for the 502 vs 503
      // reasoning recorded in the fix report.
      if (result.code === 'UPSTREAM_FAILURE') return fail('bad_gateway', result.error, 502);
      return fail('invalid_state', result.error, 409);
    }
    // Mirror the mission lifecycle routes' convention of returning the
    // resource's post-mutation state rather than a bare acknowledgement.
    // `result.task` comes straight from steerTaskForUser — no second
    // `getTask` round trip, and nothing to null-check (Finding 6).
    return ok({ task: toTaskResponse(result.task) });
  },
);
