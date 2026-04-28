import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const [, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { missionId } = await params;
  const mission = await getMission(missionId);
  if (!mission) {
    return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  }
  const tasks = await listTasksForMission(missionId);
  return NextResponse.json({ tasks });
}
