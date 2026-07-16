import type { Mission } from '@forge/db';

export type ShapeInput = Pick<
  Mission,
  'workspaceRepo' | 'targetRepos' | 'plannerStrategy' | 'issueQuery' | 'issueRef'
>;

/** A campaign mission is anything NOT tied to a repo. */
export function isCampaignMission(mission: Pick<Mission, 'workspaceRepo'>): boolean {
  return !mission.workspaceRepo;
}

/**
 * A container mission (workspaceRepo set, no issueRef, no parent) is a pure
 * budget/concurrency envelope for a repo's issue missions — it owns no
 * tasks and is never listed anywhere (Phase 1's listMissions() already
 * excludes it). Defined here for completeness; no call site in this
 * codebase needs to defensively check for one today.
 */
export function isContainerMission(
  mission: Pick<Mission, 'workspaceRepo' | 'issueRef' | 'parentMissionId'>,
): boolean {
  return !!mission.workspaceRepo && !mission.issueRef && !mission.parentMissionId;
}

/** An issue mission is a real Mission scoped to one specific GitHub issue. */
export function isIssueMission(mission: Pick<Mission, 'issueRef'>): boolean {
  return !!mission.issueRef;
}

/** One-line description of what a mission targets, for list rows and badges. */
export function missionShapeLabel(mission: ShapeInput): string {
  if (mission.issueRef) return `Issue · ${mission.issueRef}`;

  if (mission.plannerStrategy === 'triage') {
    return mission.issueQuery ? `Triage · ${mission.issueQuery}` : 'Triage';
  }

  const repos = mission.targetRepos ?? [];
  if (repos.length === 0) return 'Campaign';
  if (repos.length === 1) return `Single repo · ${repos[0]}`;
  return `Fleet · ${repos.length} repos`;
}
