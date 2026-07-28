import { withApiAuth } from '@/lib/api/auth';
import { toTaskResponse } from '@/lib/api/dto';
import { notFound, ok } from '@/lib/api/respond';
import { getTask } from '@/lib/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId, taskId } = await params;

    // A read, so getTask(taskId, user.id) really is the only ownership check
    // on this path — unlike the mutating task routes, which check again
    // inside the lib call they delegate to (see the approve route). Do not
    // add a second gate on a DIFFERENT id (getMission(missionId, user.id)):
    // its 404 would fire for "you don't own the mission in the URL" and go
    // on answering 404 with getTask's userId filter removed, proving the
    // wrong thing. The URL's missionId is compared against the
    // already-ownership-proven task's own missionId column instead.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    return ok({ task: toTaskResponse(task) });
  },
);
