import { withApiAuth } from '@/lib/api/auth';
import { plannerFailure } from '@/lib/api/errors';
import { toMissionResponse } from '@/lib/api/dto';
import { failWith, notFound, ok } from '@/lib/api/respond';
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
      // `skipped` is always present (null when nothing was dropped) so a CLI
      // can read one field unconditionally instead of inferring a filter ran
      // from a taskCount it has no baseline for. See PlanResult (lib/planner.ts).
      return ok({
        mission: toMissionResponse(result.mission),
        taskCount: result.taskCount,
        skipped: result.skipped ?? null,
      });
    } catch (err) {
      // PlannerError's own codes (MISSION_NOT_FOUND/WRONG_STATUS/
      // NO_TARGET_REPOS/ALREADY_PLANNED) never reach the wire —
      // plannerFailure maps them onto the closed set in lib/api/errors.ts.
      // The three that collapse onto `invalid_state` stay distinguishable
      // through the domain message, which is preserved verbatim.
      if (err instanceof PlannerError) return failWith(plannerFailure(err));
      throw err;
    }
  },
);
