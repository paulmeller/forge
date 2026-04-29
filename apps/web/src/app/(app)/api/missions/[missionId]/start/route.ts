import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import { MissionTransitionError, startMission } from '@/lib/mission-transitions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const [, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { missionId } = await params;
  try {
    const mission = await startMission(missionId);
    return NextResponse.json({ mission });
  } catch (err) {
    if (err instanceof MissionTransitionError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
