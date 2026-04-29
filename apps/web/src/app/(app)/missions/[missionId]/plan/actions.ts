'use server';

import { revalidatePath } from 'next/cache';

import { addTask, removeTask, updateTaskPromptVars, TaskEditError } from '@/lib/task-edits';

export type AddTaskState = { error?: string };
export type RemoveTaskState = { error?: string };
export type UpdateVarsState = { error?: string };

export async function addTaskAction(
  _prev: AddTaskState,
  formData: FormData,
): Promise<AddTaskState> {
  const missionId = formData.get('missionId');
  const repo = formData.get('repo');
  const baseBranch = formData.get('baseBranch');
  if (typeof missionId !== 'string' || typeof repo !== 'string') {
    return { error: 'missing missionId or repo' };
  }
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
  const missionId = formData.get('missionId');
  const taskId = formData.get('taskId');
  if (typeof missionId !== 'string' || typeof taskId !== 'string') {
    return { error: 'missing missionId or taskId' };
  }
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
  const missionId = formData.get('missionId');
  const taskId = formData.get('taskId');
  const varsJson = formData.get('promptVars');
  if (typeof missionId !== 'string' || typeof taskId !== 'string' || typeof varsJson !== 'string') {
    return { error: 'missing fields' };
  }
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
