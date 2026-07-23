import type { Mission, MissionStatus } from '@forge/db';

/**
 * Groups missions by every repo they target. A campaign mission spanning
 * multiple repos is deliberately added to each one's group — it genuinely
 * is active/completed work for all of them, not a duplication bug.
 */
export function groupMissionsByRepo(missions: Mission[]): Map<string, Mission[]> {
  const map = new Map<string, Mission[]>();
  for (const mission of missions) {
    for (const repo of mission.targetRepos ?? []) {
      const list = map.get(repo) ?? [];
      list.push(mission);
      map.set(repo, list);
    }
  }
  return map;
}

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(['completed', 'cancelled']);

/**
 * Summarizes one repo's mission group: a single running/completed label
 * (running if anything is still non-terminal), a per-status count
 * breakdown, and the most recently created mission's createdAt. Counts
 * missions, not tasks — no task-level rollup is involved.
 */
export function summarizeRepoMissions(missions: Mission[]): {
  status: 'running' | 'completed';
  breakdown: Array<{ status: MissionStatus; count: number }>;
  mostRecentCreatedAt: Date;
} {
  const status = missions.some((m) => !TERMINAL_MISSION_STATUSES.has(m.status))
    ? 'running'
    : 'completed';

  const counts = new Map<MissionStatus, number>();
  for (const m of missions) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([status, count]) => ({ status, count }));

  const mostRecentCreatedAt = missions.reduce(
    (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
    missions[0]!.createdAt,
  );

  return { status, breakdown, mostRecentCreatedAt };
}
