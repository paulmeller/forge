import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { fail, ok } from '@/lib/api/respond';
import { createMissionForUser, createMissionSchema, listMissionsForUser } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth(async (user) => {
  const missions = await listMissionsForUser(user.id);
  return ok(missions);
});

export const POST = withApiAuth(async (user, req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'Invalid JSON body', 400);
  }

  try {
    const input = createMissionSchema.parse(body);
    const mission = await createMissionForUser(user.id, input);
    return ok(mission, 201);
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
    }
    throw err;
  }
});
