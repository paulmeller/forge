import { describe, expect, it } from 'vitest';

import { isCampaignMission, isStandingMission, missionShapeLabel, type ShapeInput } from './mission-shape';

function shape(over: Partial<{
  workspaceRepo: string | null;
  targetRepos: string[] | null;
  plannerStrategy: 'rule-based' | 'llm' | 'graph' | 'triage';
  issueQuery: string | null;
}> = {}): ShapeInput {
  return {
    workspaceRepo: null,
    targetRepos: [],
    plannerStrategy: 'rule-based',
    issueQuery: null,
    ...over,
  } as ShapeInput;
}

describe('isCampaignMission / isStandingMission', () => {
  it('a mission with no workspaceRepo is a campaign', () => {
    expect(isCampaignMission(shape())).toBe(true);
    expect(isStandingMission(shape())).toBe(false);
  });

  it('a mission with workspaceRepo set is standing', () => {
    expect(isCampaignMission(shape({ workspaceRepo: 'acme/api' }))).toBe(false);
    expect(isStandingMission(shape({ workspaceRepo: 'acme/api' }))).toBe(true);
  });
});

describe('missionShapeLabel', () => {
  it('labels a standing mission by its repo, regardless of other fields', () => {
    expect(
      missionShapeLabel(
        shape({ workspaceRepo: 'acme/api', plannerStrategy: 'triage', targetRepos: ['acme/api'] }),
      ),
    ).toBe('Standing · acme/api');
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
