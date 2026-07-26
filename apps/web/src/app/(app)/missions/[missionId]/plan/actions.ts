'use server';

import { revalidatePath } from 'next/cache';

import { getMission } from '@/lib/missions';
import { addTask, removeTask, updateTaskPromptVars, TaskEditError } from '@/lib/task-edits';
import { withAuth } from '@/lib/with-auth';

export type AddTaskState = { error?: string };
export type RemoveTaskState = { error?: string };
export type UpdateVarsState = { error?: string };

export async function addTaskAction(
  _prev: AddTaskState,
  formData: FormData,
): Promise<AddTaskState> {
  // Server Actions are POST endpoints reachable without ever rendering the
  // page — withAuth() is the only thing standing between an unauthenticated
  // visitor and a plan edit, so it must run before anything else.
  const user = await withAuth();

  const missionId = formData.get('missionId');
  const repo = formData.get('repo');
  const baseBranch = formData.get('baseBranch');
  if (typeof missionId !== 'string' || typeof repo !== 'string') {
    return { error: 'missing missionId or repo' };
  }

  const mission = await getMission(missionId, user.id);
  if (!mission) return { error: 'mission not found' };

  try {
    await addTask(missionId, {
      repo: repo.trim(),
      baseBranch: typeof baseBranch === 'string' ? baseBranch : undefined,
    });
    revalidatePath(`/missions/${missionId}/plan`);
    return {};
  } catch (err) {
    if (err instanceof TaskEditError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Unexpected error' };
  }
}

export async function removeTaskAction(
  _prev: RemoveTaskState,
  formData: FormData,
): Promise<RemoveTaskState> {
  const user = await withAuth();

  const missionId = formData.get('missionId');
  const taskId = formData.get('taskId');
  if (typeof missionId !== 'string' || typeof taskId !== 'string') {
    return { error: 'missing missionId or taskId' };
  }

  const mission = await getMission(missionId, user.id);
  if (!mission) return { error: 'mission not found' };

  try {
    await removeTask(missionId, taskId);
    revalidatePath(`/missions/${missionId}/plan`);
    return {};
  } catch (err) {
    if (err instanceof TaskEditError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Unexpected error' };
  }
}

export async function updatePromptVarsAction(
  _prev: UpdateVarsState,
  formData: FormData,
): Promise<UpdateVarsState> {
  const user = await withAuth();

  const missionId = formData.get('missionId');
  const taskId = formData.get('taskId');
  const varsJson = formData.get('promptVars');
  if (typeof missionId !== 'string' || typeof taskId !== 'string' || typeof varsJson !== 'string') {
    return { error: 'missing fields' };
  }

  const mission = await getMission(missionId, user.id);
  if (!mission) return { error: 'mission not found' };

  try {
    const vars = JSON.parse(varsJson) as Record<string, unknown>;
    await updateTaskPromptVars(missionId, taskId, vars);
    revalidatePath(`/missions/${missionId}/plan`);
    return {};
  } catch (err) {
    if (err instanceof TaskEditError) return { error: err.message };
    return { error: err instanceof Error ? err.message : 'Unexpected error' };
  }
}
