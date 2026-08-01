import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { schemas } from '@/lib/api/schemas';
import { listLedgerForTask } from '@/lib/ledger';
import { getTask } from '@/lib/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth<{ params: Promise<{ missionId: string; taskId: string }> }>(
  async (user, req, { params }) => {
    const { missionId, taskId } = await params;

    // listLedgerForTask takes no userId, so getTask(taskId, user.id) really
    // is the only ownership check on this path — ownership is resolved
    // before any ledger row is read, and the audit trail must not be
    // cross-readable. See the task GET route's doc comment for why a second
    // gate on a DIFFERENT id (getMission(missionId, user.id)) would mask a
    // broken scope rather than add safety. The URL's missionId is compared
    // against the already-ownership-proven task's own missionId column.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    let limit: number;
    let cursor: string | undefined;
    try {
      ({ limit, cursor } = schemas['ledger.task'].query.parse(
        Object.fromEntries(new URL(req.url).searchParams),
      ));
    } catch (err) {
      if (err instanceof ZodError) {
        return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
      }
      throw err;
    }

    return ok(await listLedgerForTask(taskId, limit, cursor));
  },
);
