'use server';

import { redirect } from 'next/navigation';
import { ZodError } from 'zod';

import { createMission, createMissionSchema, parseRepoList } from '@/lib/missions';

export type CreateMissionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

function toNullableString(v: FormDataEntryValue | null): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  return v;
}

export async function createMissionAction(
  _prevState: CreateMissionState,
  formData: FormData,
): Promise<CreateMissionState> {
  const targetReposRaw = formData.get('targetRepos');
  const raw = {
    name: formData.get('name'),
    goal: formData.get('goal'),
    backend: formData.get('backend'),
    agentId: formData.get('agentId'),
    plannerStrategy: formData.get('plannerStrategy') || 'rule-based',
    targetRepos: parseRepoList(typeof targetReposRaw === 'string' ? targetReposRaw : ''),
    concurrencyCap: formData.get('concurrencyCap') || 5,
    budgetUsd: toNullableString(formData.get('budgetUsd')),
    budgetTokens: toNullableString(formData.get('budgetTokens')),
    budgetThresholdPct: formData.get('budgetThresholdPct') || 80,
    budgetHardStopPct: formData.get('budgetHardStopPct') || 100,
    taskMaxTurns: toNullableString(formData.get('taskMaxTurns')),
    taskMaxTokens: toNullableString(formData.get('taskMaxTokens')),
    noProgressTokens: toNullableString(formData.get('noProgressTokens')),
    githubInstallationId: toNullableString(formData.get('githubInstallationId')),
    githubVaultId: toNullableString(formData.get('githubVaultId')),
    skillId: toNullableString(formData.get('skillId')),
    aiReviewEnabled: formData.get('aiReviewEnabled') === 'on',
    selfVerifyEnabled: formData.get('selfVerifyEnabled') === 'on',
  };

  let mission;
  try {
    const input = createMissionSchema.parse(raw);
    mission = await createMission(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.');
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { error: 'Please correct the errors below.', fieldErrors };
    }
    return { error: err instanceof Error ? err.message : 'Unexpected error' };
  }

  redirect(`/missions/${mission.id}`);
}
