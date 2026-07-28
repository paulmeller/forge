import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { schemas } from '@/lib/api/schemas';
import { listLedgerForMission } from '@/lib/ledger';
import { getMission } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, req, { params }) => {
    const { missionId } = await params;

    // Ownership is checked on the MISSION before any ledger row is read —
    // the audit trail must not be cross-readable. getMission(missionId,
    // user.id) is the sole gate; see the task route's doc comment for why a
    // second ownership check alongside it would be redundant, not extra
    // safety.
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');

    let limit: number;
    try {
      ({ limit } = schemas['ledger.mission'].query.parse(
        Object.fromEntries(new URL(req.url).searchParams),
      ));
    } catch (err) {
      if (err instanceof ZodError) {
        return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
      }
      throw err;
    }

    return ok({ events: await listLedgerForMission(missionId, limit) });
  },
);
