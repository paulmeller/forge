import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { abortTaskForUser } from '@/lib/task-session-ops';
import { getTask } from '@/lib/tasks';

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

    const result = await abortTaskForUser(taskId, user.id);
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
    // `result.task` comes straight from the mutation's own `.returning()` —
    // no second `getTask` round trip, and nothing to null-check (Finding 6).
    return ok({ task: result.task });
  },
);
