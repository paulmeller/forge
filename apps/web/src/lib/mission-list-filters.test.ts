import { describe, expect, it } from 'vitest';
import type { Mission } from '@forge/db';

import { filterMissionList, hasActiveMissionListFilters } from './mission-list-filters';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_1',
    name: 'Test mission',
    status: 'running',
    backend: 'managed-agents',
    workspaceRepo: null,
    targetRepos: [],
    issueRef: null,
    parentMissionId: null,
    ...over,
  } as Mission;
}

describe('filterMissionList', () => {
  it('returns every mission when no filters are set', () => {
    const missions = [mission({ id: 'a' }), mission({ id: 'b' })];
    expect(filterMissionList(missions, {}).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('filters to campaigns when kind=campaigns', () => {
    const campaign = mission({ id: 'a', workspaceRepo: null });
    const issue = mission({ id: 'b', workspaceRepo: 'acme/api', issueRef: 'acme/api#1' });
    const result = filterMissionList([campaign, issue], { kind: 'campaigns' });
    expect(result.map((m) => m.id)).toEqual(['a']);
  });

  it('filters to issues when kind=issues', () => {
    const campaign = mission({ id: 'a', workspaceRepo: null });
    const issue = mission({ id: 'b', workspaceRepo: 'acme/api', issueRef: 'acme/api#1' });
    const result = filterMissionList([campaign, issue], { kind: 'issues' });
    expect(result.map((m) => m.id)).toEqual(['b']);
  });

  it('filters by exact repo match', () => {
    const missions = [
      mission({ id: 'a', workspaceRepo: 'acme/api' }),
      mission({ id: 'b', workspaceRepo: 'acme/web' }),
    ];
    expect(filterMissionList(missions, { repo: 'acme/api' }).map((m) => m.id)).toEqual(['a']);
  });

  it('filters by comma-separated status list', () => {
    const missions = [
      mission({ id: 'a', status: 'running' }),
      mission({ id: 'b', status: 'paused' }),
      mission({ id: 'c', status: 'completed' }),
    ];
    const result = filterMissionList(missions, { status: 'running,paused' });
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('filters by exact backend match', () => {
    const missions = [
      mission({ id: 'a', backend: 'managed-agents' }),
      mission({ id: 'b', backend: 'gateway' }),
    ];
    expect(filterMissionList(missions, { backend: 'gateway' }).map((m) => m.id)).toEqual(['b']);
  });

  it('filters by case-insensitive search across name and target repos', () => {
    const missions = [
      mission({ id: 'a', name: 'Fix the Widget' }),
      mission({ id: 'b', name: 'Other', targetRepos: ['Acme/Widget-Repo'] }),
      mission({ id: 'c', name: 'Unrelated', targetRepos: ['acme/other'] }),
    ];
    const result = filterMissionList(missions, { q: 'widget' });
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('composes multiple filters with AND semantics', () => {
    const missions = [
      mission({ id: 'a', status: 'running', backend: 'gateway', workspaceRepo: null }),
      mission({ id: 'b', status: 'running', backend: 'managed-agents', workspaceRepo: null }),
    ];
    const result = filterMissionList(missions, { status: 'running', backend: 'gateway' });
    expect(result.map((m) => m.id)).toEqual(['a']);
  });
});

describe('hasActiveMissionListFilters', () => {
  it('is false when no filters are set', () => {
    expect(hasActiveMissionListFilters({})).toBe(false);
  });

  it('is false when kind is explicitly "all"', () => {
    expect(hasActiveMissionListFilters({ kind: 'all' })).toBe(false);
  });

  it.each([
    { status: 'running' },
    { backend: 'gateway' },
    { q: 'widget' },
    { kind: 'campaigns' },
    { repo: 'acme/api' },
  ])('is true when %o is set', (filters) => {
    expect(hasActiveMissionListFilters(filters)).toBe(true);
  });
});
