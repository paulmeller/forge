'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  MissionTransitionError,
  pauseMission,
  resumeMission,
  startMission,
} from '@/lib/mission-transitions';
import { getMission } from '@/lib/missions';
import { PlannerError, runPlanner } from '@/lib/planner';
import { withAuth } from '@/lib/with-auth';

export type MissionActionState = {
  error?: string;
  taskCount?: number;
};

type Op = 'plan' | 'start' | 'pause' | 'resume';

export async function missionAction(
  _prevState: MissionActionState,
  formData: FormData,
): Promise<MissionActionState> {
  // Server Actions are POST endpoints reachable without ever rendering the
  // page — withAuth() is the only thing standing between an unauthenticated
  // visitor and a mission transition, so it must run before anything else.
  const user = await withAuth();

  const missionId = formData.get('missionId');
  const op = formData.get('op');
  if (typeof missionId !== 'string') return { error: 'missing missionId' };
  if (typeof op !== 'string') return { error: 'missing op' };

  const mission = await getMission(missionId, user.id);
  if (!mission) return { error: 'mission not found' };

  let redirectTo: string | null = null;
  try {
    switch (op as Op) {
      case 'plan': {
        const result = await runPlanner(missionId);
        revalidatePath(`/missions/${missionId}`);
        // Take the operator straight to plan preview to review/edit Tasks
        // before clicking Start. Per PRD §7.3 / §16.1.
        redirectTo = `/missions/${missionId}/plan`;
        // Set state for the brief moment before redirect.
        // (Returning here would skip the redirect — fall through.)
        void result;
        break;
      }
      case 'start':
        await startMission(missionId);
        revalidatePath(`/missions/${missionId}`);
        redirectTo = `/missions/${missionId}`;
        break;
      case 'pause':
        await pauseMission(missionId);
        revalidatePath(`/missions/${missionId}`);
        return {};
      case 'resume':
        await resumeMission(missionId);
        revalidatePath(`/missions/${missionId}`);
        return {};
      default:
        return { error: `unknown op: ${op}` };
    }
  } catch (err) {
    if (err instanceof PlannerError) return { error: err.message };
    if (err instanceof MissionTransitionError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Unexpected error' };
  }
  if (redirectTo) redirect(redirectTo);
  return {};
}
