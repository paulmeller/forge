import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { getTask } from '@/lib/tasks';
import { reviewTask } from '@/lib/task-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId, taskId } = await params;

    // getTask(taskId, user.id) is the sole ownership gate — a task belonging
    // to another account and a nonexistent task must be indistinguishable.
    // Do not additionally gate on getMission(missionId, user.id): that would
    // be a second, independent ownership check on a *different* id, and its
    // own 404 would mask a broken ownership scope on getTask itself (a
    // mutation dropping getTask's userId filter would still 404 here purely
    // because the caller doesn't own the mission id in the URL — proving
    // the wrong thing). The URL's missionId is validated for path
    // consistency only, against the already-ownership-proven task's own
    // missionId column — the same check the equivalent page uses
    // (missions/[missionId]/tasks/[taskId]/page.tsx).
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    const result = await reviewTask(taskId, user.id, 'approve');
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound('Task');
      return fail('invalid_state', result.error, 409);
    }
    return ok({ task: result.task });
  },
);
