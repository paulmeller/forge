import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import { PlannerError, runPlanner } from '@/lib/planner';

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
    const result = await runPlanner(missionId);
    return NextResponse.json({
      mission: result.mission,
      taskCount: result.taskCount,
    });
  } catch (err) {
    if (err instanceof PlannerError) {
      const status = err.code === 'MISSION_NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
