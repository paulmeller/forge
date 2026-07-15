import { describe, expect, it, vi } from 'vitest';

import type { Mission, NewMission } from '@forge/db';

import type { MissionDefaults } from './mission-defaults';
import { getOrCreateWorkspaceMission } from './workspace-mission';

const defaults: MissionDefaults = {
  agentId: 'agent_abc',
  githubInstallationId: '123',
  githubVaultId: 'vault_abc',
  source: 'setup',
};

function fakeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_existing',
    userId: 'usr_1',
    name: 'Issues — acme/api',
    goal: 'Triage open issues in acme/api',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_abc',
    plannerStrategy: 'triage',
    targetRepos: ['acme/api'],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    spentUsd: 0,
    spentTokens: 0,
    autoMergePolicy: null,
    webhookSecret: 'secret',
    githubInstallationId: '123',
    githubVaultId: 'vault_abc',
    skillId: null,
    aiReviewEnabled: false,
    budgetHardStopPct: 100,
    taskMaxTokens: null,
    taskMaxTurns: null,
    noProgressTokens: null,
    selfVerifyEnabled: false,
    workspaceRepo: 'acme/api',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    ...over,
  } as Mission;
}

describe('getOrCreateWorkspaceMission', () => {
  it('returns the existing mission without inserting when one is found', async () => {
    const existing = fakeMission();
    const findExisting = vi.fn().mockResolvedValue(existing);
    const insertMission = vi.fn();

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(existing);
    expect(findExisting).toHaveBeenCalledWith('usr_1', 'acme/api');
    expect(insertMission).not.toHaveBeenCalled();
  });

  it('inserts a new running mission scoped to the repo when none exists', async () => {
    const inserted = fakeMission({ id: 'msn_new' });
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(inserted);
    expect(insertMission).toHaveBeenCalledTimes(1);
    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.workspaceRepo).toBe('acme/api');
    expect(values.targetRepos).toEqual(['acme/api']);
    expect(values.plannerStrategy).toBe('triage');
    expect(values.status).toBe('running');
    expect(values.agentId).toBe('agent_abc');
    expect(values.githubInstallationId).toBe('123');
    expect(values.githubVaultId).toBe('vault_abc');
    expect(values.budgetUsd).toBeNull();
    expect(values.name).toBe('Issues — acme/api');
    expect(values.goal).toContain('acme/api');
  });

  it('propagates a null agentId from defaults rather than inventing one', async () => {
    const noAgentDefaults: MissionDefaults = { ...defaults, agentId: null, source: 'none' };
    const inserted = fakeMission({ agentId: '' });
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    await getOrCreateWorkspaceMission('usr_1', 'acme/api', noAgentDefaults, {
      findExisting,
      insertMission,
    });

    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.agentId).toBe('');
  });
});
