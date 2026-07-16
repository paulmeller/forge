import { describe, expect, it } from 'vitest';

import {
  isCampaignMission,
  isContainerMission,
  isIssueMission,
  missionShapeLabel,
  type ShapeInput,
} from './mission-shape';

function shape(over: Partial<{
  workspaceRepo: string | null;
  targetRepos: string[] | null;
  plannerStrategy: 'rule-based' | 'llm' | 'graph' | 'triage';
  issueQuery: string | null;
  issueRef: string | null;
  parentMissionId: string | null;
}> = {}): ShapeInput & { parentMissionId: string | null } {
  return {
    workspaceRepo: null,
    targetRepos: [],
    plannerStrategy: 'rule-based',
    issueQuery: null,
    issueRef: null,
    parentMissionId: null,
    ...over,
  } as ShapeInput & { parentMissionId: string | null };
}

describe('isCampaignMission', () => {
  it('a mission with no workspaceRepo is a campaign', () => {
    expect(isCampaignMission(shape())).toBe(true);
  });

  it('a mission with workspaceRepo set is not a campaign', () => {
    expect(isCampaignMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
  });
});

describe('isContainerMission', () => {
  it('a mission with workspaceRepo set and no issueRef/parentMissionId is a container', () => {
    expect(
      isContainerMission(shape({ workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null })),
    ).toBe(true);
  });

  it('a mission with issueRef set is not a container, even with workspaceRepo set', () => {
    expect(
      isContainerMission(
        shape({ workspaceRepo: 'acme/api', issueRef: 'acme/api#1', parentMissionId: 'msn_x' }),
      ),
    ).toBe(false);
  });

  it('a campaign (no workspaceRepo) is not a container', () => {
    expect(isContainerMission(shape())).toBe(false);
  });
});

describe('isIssueMission', () => {
  it('a mission with issueRef set is an issue mission', () => {
    expect(isIssueMission(shape({ issueRef: 'acme/api#42' }))).toBe(true);
  });

  it('a mission with no issueRef is not an issue mission', () => {
    expect(isIssueMission(shape())).toBe(false);
    expect(isIssueMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
  });
});

describe('missionShapeLabel', () => {
  it('labels an issue mission by its issueRef, regardless of other fields', () => {
    expect(
      missionShapeLabel(
        shape({
          workspaceRepo: 'acme/api',
          issueRef: 'acme/api#42',
          plannerStrategy: 'triage',
          targetRepos: ['acme/api'],
        }),
      ),
    ).toBe('Issue · acme/api#42');
  });

  it('labels a triage campaign by its issue query', () => {
    expect(
      missionShapeLabel(
        shape({ plannerStrategy: 'triage', issueQuery: 'repo:acme/api is:open label:bug' }),
      ),
    ).toBe('Triage · repo:acme/api is:open label:bug');
  });

  it('labels a single-repo campaign by its one repo', () => {
    expect(missionShapeLabel(shape({ targetRepos: ['acme/api'] }))).toBe('Single repo · acme/api');
  });

  it('labels a multi-repo campaign as Fleet with a count', () => {
    expect(
      missionShapeLabel(shape({ targetRepos: ['acme/api', 'acme/web', 'acme/mobile'] })),
    ).toBe('Fleet · 3 repos');
  });

  it('falls back to a generic label when there are no target repos and no query', () => {
    expect(missionShapeLabel(shape({ targetRepos: [] }))).toBe('Campaign');
    expect(missionShapeLabel(shape({ targetRepos: null }))).toBe('Campaign');
  });
});
