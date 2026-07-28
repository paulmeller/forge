import { withApiAuth } from '@/lib/api/auth';
import { missionTransitionFailure } from '@/lib/api/errors';
import { toMissionResponse } from '@/lib/api/dto';
import { failWith, notFound, ok } from '@/lib/api/respond';
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
      return ok({ mission: toMissionResponse(updated) });
    } catch (err) {
      // MissionTransitionError's own codes (NOT_FOUND/WRONG_STATUS) never
      // reach the wire — missionTransitionFailure maps them onto the closed
      // set in lib/api/errors.ts, keeping the domain message verbatim.
      if (err instanceof MissionTransitionError) return failWith(missionTransitionFailure(err));
      throw err;
    }
  },
);
