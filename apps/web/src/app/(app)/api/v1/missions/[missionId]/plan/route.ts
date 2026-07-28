import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { getMission } from '@/lib/missions';
import { PlannerError, runPlanner } from '@/lib/planner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId } = await params;
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');

    try {
      const result = await runPlanner(missionId);
      return ok({ mission: result.mission, taskCount: result.taskCount });
    } catch (err) {
      if (err instanceof PlannerError) {
        const status = err.code === 'MISSION_NOT_FOUND' ? 404 : 409;
        return fail(err.code, err.message, status);
      }
      throw err;
    }
  },
);
