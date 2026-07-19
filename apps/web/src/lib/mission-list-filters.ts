import type { Mission } from '@forge/db';

import { isCampaignMission, isIssueMission } from './mission-shape';

export type MissionListFilters = {
  kind?: string;
  repo?: string;
  status?: string;
  backend?: string;
  q?: string;
};

/** Applies the missions list's filter pills/search — shared by /missions and /home. */
export function filterMissionList(missions: Mission[], filters: MissionListFilters): Mission[] {
  let result = missions;

  if (filters.kind === 'campaigns') {
    result = result.filter(isCampaignMission);
  } else if (filters.kind === 'issues') {
    result = result.filter(isIssueMission);
  }

  if (filters.repo) {
    result = result.filter((m) => m.workspaceRepo === filters.repo);
  }

  if (filters.status) {
    const statuses = new Set(filters.status.split(',').filter(Boolean));
    result = result.filter((m) => statuses.has(m.status));
  }

  if (filters.backend) {
    result = result.filter((m) => m.backend === filters.backend);
  }

  if (filters.q) {
    const q = filters.q.toLowerCase();
    result = result.filter((m) => {
      const repos = (m.targetRepos ?? []) as string[];
      return m.name.toLowerCase().includes(q) || repos.some((r) => r.toLowerCase().includes(q));
    });
  }

  return result;
}

export function hasActiveMissionListFilters(filters: MissionListFilters): boolean {
  return !!(
    filters.status ||
    filters.backend ||
    filters.q ||
    (filters.kind && filters.kind !== 'all') ||
    filters.repo
  );
}
