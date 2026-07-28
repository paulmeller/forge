import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { fail, ok } from '@/lib/api/respond';
import { schemas } from '@/lib/api/schemas';
import { createMissionForUser, listMissionsForUser, RepoAccessError } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth(async (user, req) => {
  const { searchParams } = new URL(req.url);
  let status: string | undefined;
  try {
    ({ status } = schemas['missions.list'].query.parse(Object.fromEntries(searchParams)));
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
    }
    throw err;
  }

  const missions = await listMissionsForUser(user.id, status);
  return ok({ missions });
});

export const POST = withApiAuth(async (user, req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'Invalid JSON body', 400);
  }

  try {
    const input = schemas['missions.create'].body.parse(body);
    const mission = await createMissionForUser(user.id, input);
    return ok({ mission }, 201);
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
    }
    if (err instanceof RepoAccessError) {
      return fail('forbidden', err.message, 403);
    }
    throw err;
  }
});
