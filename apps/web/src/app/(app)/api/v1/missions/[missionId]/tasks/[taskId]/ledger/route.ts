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

    // getTask(taskId, user.id) is the sole ownership gate — ownership is
    // resolved before any ledger row is read, and the audit trail must not
    // be cross-readable. See the task GET route's doc comment for why a
    // second getMission(missionId, user.id) check alongside it would mask a
    // broken ownership scope rather than add safety. The URL's missionId is
    // validated for path consistency only, against the already-ownership-
    // proven task's own missionId column.
    const task = await getTask(taskId, user.id);
    if (!task || task.missionId !== missionId) return notFound('Task');

    let limit: number;
    try {
      ({ limit } = schemas['ledger.task'].query.parse(
        Object.fromEntries(new URL(req.url).searchParams),
      ));
    } catch (err) {
      if (err instanceof ZodError) {
        return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
      }
      throw err;
    }

    return ok({ events: await listLedgerForTask(taskId, limit) });
  },
);
