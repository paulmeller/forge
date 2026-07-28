import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { getTask } from '@/lib/tasks';
import { reviewTask } from '@/lib/task-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId, taskId } = await params;

    // getTask(taskId, user.id) is the sole ownership gate — see the approve
    // route's doc comment for why a second getMission(missionId, user.id)
    // ownership check would mask a broken ownership scope here instead of
    // catching it. The URL's missionId is validated for path consistency
    // only, against the already-ownership-proven task's own missionId
    // column.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    const result = await reviewTask(taskId, user.id, 'dismiss');
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound('Task');
      return fail('invalid_state', result.error, 409);
    }
    return ok(result.task);
  },
);
