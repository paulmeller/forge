import type { Mission } from '@forge/db';

export type ShapeInput = Pick<Mission, 'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery'>;

/** A campaign mission is anything NOT tied to a repo's standing workspace. */
export function isCampaignMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !mission.workspaceRepo;
}

export function isStandingMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !!mission.workspaceRepo;
}

/** One-line description of what a mission targets, for list rows and badges. */
export function missionShapeLabel(mission: ShapeInput): string {
  if (mission.workspaceRepo) return `Standing · ${mission.workspaceRepo}`;

  if (mission.plannerStrategy === 'triage') {
    return mission.issueQuery ? `Triage · ${mission.issueQuery}` : 'Triage';
  }

  const repos = mission.targetRepos ?? [];
  if (repos.length === 0) return 'Campaign';
  if (repos.length === 1) return `Single repo · ${repos[0]}`;
  return `Fleet · ${repos.length} repos`;
}
