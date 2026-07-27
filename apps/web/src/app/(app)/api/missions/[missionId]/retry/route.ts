import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import { MissionTransitionError, retryMission } from '@/lib/mission-transitions';
import { getMission } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { missionId } = await params;
  const mission = await getMission(missionId, user.id);
  if (!mission) {
    return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  }

  try {
    const { mission: updated, retriedCount } = await retryMission(missionId);
    return NextResponse.json({ mission: updated, retriedCount });
  } catch (err) {
    if (err instanceof MissionTransitionError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
