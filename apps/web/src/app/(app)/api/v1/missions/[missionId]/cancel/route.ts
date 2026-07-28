import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { MissionTransitionError, cancelMission } from '@/lib/mission-transitions';
import { getMission } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId } = await params;
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');

    try {
      const updated = await cancelMission(missionId);
      return ok(updated);
    } catch (err) {
      if (err instanceof MissionTransitionError) {
        const status = err.code === 'NOT_FOUND' ? 404 : 409;
        return fail(err.code, err.message, status);
      }
      throw err;
    }
  },
);
