import { describe, expect, it } from 'vitest';
import type { Mission, MissionStatus } from '@forge/db';

import { groupMissionsByRepo, summarizeRepoMissions } from './group-missions-by-repo';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_1',
    name: 'Test mission',
    status: 'running',
    backend: 'managed-agents',
    workspaceRepo: null,
    targetRepos: ['acme/api'],
    issueRef: null,
    parentMissionId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  } as Mission;
}

describe('groupMissionsByRepo', () => {
  it('groups missions by their single target repo', () => {
    const a = mission({ id: 'a', targetRepos: ['acme/api'] });
    const b = mission({ id: 'b', targetRepos: ['acme/widgets'] });
    const result = groupMissionsByRepo([a, b]);
    expect(result.get('acme/api')?.map((m) => m.id)).toEqual(['a']);
    expect(result.get('acme/widgets')?.map((m) => m.id)).toEqual(['b']);
  });

  it('a mission targeting multiple repos appears in every one of its repo groups', () => {
    const campaign = mission({ id: 'c', targetRepos: ['acme/api', 'acme/widgets'] });
    const result = groupMissionsByRepo([campaign]);
    expect(result.get('acme/api')?.map((m) => m.id)).toEqual(['c']);
    expect(result.get('acme/widgets')?.map((m) => m.id)).toEqual(['c']);
  });

  it('adds no group for a mission with no target repos', () => {
    const noRepo = mission({ id: 'x', targetRepos: [] });
    const result = groupMissionsByRepo([noRepo]);
    expect(result.size).toBe(0);
  });
});

describe('summarizeRepoMissions', () => {
  it.each([
    ['draft', 'running'],
    ['planning', 'running'],
    ['running', 'running'],
    ['paused', 'running'],
    ['completed', 'completed'],
    ['cancelled', 'completed'],
  ] as Array<[MissionStatus, 'running' | 'completed']>)(
    'a lone mission with status %s summarizes to %s',
    (status, expected) => {
      const result = summarizeRepoMissions([mission({ status })]);
      expect(result.status).toBe(expected);
    },
  );

  it('summarizes to running when at least one mission is non-terminal, even if others are terminal', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'completed' }),
      mission({ id: 'b', status: 'running' }),
    ]);
    expect(result.status).toBe('running');
  });

  it('summarizes to completed only when every mission is terminal', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'completed' }),
      mission({ id: 'b', status: 'cancelled' }),
    ]);
    expect(result.status).toBe('completed');
  });

  it('produces a count breakdown per status', () => {
    const result = summarizeRepoMissions([
      mission({ id: 'a', status: 'running' }),
      mission({ id: 'b', status: 'running' }),
      mission({ id: 'c', status: 'completed' }),
    ]);
    expect(result.breakdown).toEqual(
      expect.arrayContaining([
        { status: 'running', count: 2 },
        { status: 'completed', count: 1 },
      ]),
    );
    expect(result.breakdown).toHaveLength(2);
  });

  it("picks the most recently created mission's createdAt", () => {
    const older = mission({ id: 'a', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = mission({ id: 'b', createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const result = summarizeRepoMissions([older, newer]);
    expect(result.mostRecentCreatedAt).toEqual(newer.createdAt);
  });
});
