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
    // the audit trail must not be cross-readable. listLedgerForMission takes
    // no userId, so this getMission(missionId, user.id) is the only
    // ownership check on the path. A second gate on a different id would not
    // add safety here — see the task routes' doc comments for the case where
    // one masked a broken scope entirely.
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');

    let limit: number;
    let cursor: string | undefined;
    try {
      ({ limit, cursor } = schemas['ledger.mission'].query.parse(
        Object.fromEntries(new URL(req.url).searchParams),
      ));
    } catch (err) {
      if (err instanceof ZodError) {
        return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
      }
      throw err;
    }

    return ok(await listLedgerForMission(missionId, limit, cursor));
  },
);
