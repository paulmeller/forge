import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { apiAuth } from '@/lib/api-auth';
import { createMissionForUser, createMissionSchema, listMissionsForUser } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const missions = await listMissionsForUser(user.id);
  return NextResponse.json({ missions });
}

export async function POST(request: Request) {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const input = createMissionSchema.parse(body);
    const mission = await createMissionForUser(user.id, input);
    return NextResponse.json({ mission }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'validation failed', issues: err.issues },
        { status: 400 },
      );
    }
    throw err;
  }
}
