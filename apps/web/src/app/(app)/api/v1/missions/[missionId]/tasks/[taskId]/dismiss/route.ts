import { withApiAuth } from '@/lib/api/auth';
import { toTaskResponse } from '@/lib/api/dto';
import { fail, notFound, ok } from '@/lib/api/respond';
import { getTask } from '@/lib/tasks';
import { reviewTask } from '@/lib/task-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId, taskId } = await params;

    // Ownership is checked twice on this path — here, and again inside
    // reviewTask, which repeats getTask(taskId, user.id) so the Server
    // Action transport is gated too. Same function, same predicate, same id,
    // so neither hides a break in the other; see the approve route's doc
    // comment for why that is benign while a second check on a DIFFERENT id
    // (getMission(missionId, user.id)) would not be. This call is also what
    // the missionId path-consistency check below compares against: the URL's
    // missionId is matched to the already-ownership-proven task's own
    // missionId column, never re-queried.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    const result = await reviewTask(taskId, user.id, 'dismiss');
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound('Task');
      return fail('invalid_state', result.error, 409);
    }
    return ok({ task: toTaskResponse(result.task) });
  },
);
