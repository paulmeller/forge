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

    // Ownership is checked TWICE on this path, on the same id with the same
    // predicate. Spelled out because this comment used to claim otherwise:
    //
    //   1. this getTask(taskId, user.id) — which the missionId
    //      path-consistency check below has nothing to compare against
    //      without, and which produces the 404 before reviewTask is engaged;
    //   2. reviewTask's own getTask(taskId, user.id) (lib/task-review.ts) —
    //      the gate the Server Action transport gets, which must hold
    //      whether or not a route ran first.
    //
    // Two calls to ONE function with ONE predicate is why this is benign
    // rather than the masking pattern below: a mutation dropping getTask's
    // userId filter breaks both at once, and the lib half is proven
    // independently of any route (lib/task-review.test.ts).
    //
    // What must NOT be added is a second check on a DIFFERENT id — an
    // additional getMission(missionId, user.id). Its own 404 fires for "you
    // don't own the mission named in the URL", which would keep answering
    // 404 even with getTask's userId filter removed entirely: it proves
    // mission ownership while appearing to prove task ownership. That
    // happened on this branch and produced zero mutation failures.
    //
    // So the URL's missionId is only ever compared against the
    // already-ownership-proven task's own missionId column, never re-queried
    // — the same check the equivalent page makes
    // (missions/[missionId]/tasks/[taskId]/page.tsx).
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    const result = await reviewTask(taskId, user.id, 'approve');
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound('Task');
      return fail('invalid_state', result.error, 409);
    }
    return ok({ task: toTaskResponse(result.task) });
  },
);
