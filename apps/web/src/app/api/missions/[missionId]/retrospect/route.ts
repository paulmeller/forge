import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import {
  createRetrospective,
  getRetrospectiveForMission,
  listProposals,
  RetrospectiveError,
} from '@/lib/retrospectives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const [, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { missionId } = await params;
  const retro = await getRetrospectiveForMission(missionId);
  if (!retro) {
    return NextResponse.json({ retrospective: null, proposals: [] });
  }

  const proposals = await listProposals(retro.id);
  return NextResponse.json({ retrospective: retro, proposals });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { missionId } = await params;
  try {
    const { retrospective } = await createRetrospective(missionId, user.id);
    return NextResponse.json({ retrospective }, { status: 201 });
  } catch (err) {
    if (err instanceof RetrospectiveError) {
      const status =
        err.code === 'MISSION_NOT_FOUND' ? 404
        : err.code === 'ALREADY_EXISTS' ? 409
        : 422;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
