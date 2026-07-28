import { withApiAuth } from '@/lib/api/auth';
import { notFound, ok } from '@/lib/api/respond';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId } = await params;
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');

    const tasks = await listTasksForMission(missionId);
    return ok(tasks);
  },
);
