import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, notInArray } from 'drizzle-orm';

import { missions, type Mission, type NewMission } from '@forge/db';

import { db } from './db';
import type { MissionDefaults } from './mission-defaults';

export type WorkspaceMissionDeps = {
  findExisting: (userId: string, repo: string) => Promise<Mission | null>;
  insertMission: (values: NewMission) => Promise<Mission>;
};

export async function dbFindExistingWorkspaceMission(
  userId: string,
  repo: string,
): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        eq(missions.workspaceRepo, repo),
        notInArray(missions.status, ['completed', 'cancelled']),
      ),
    )
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function dbInsertMission(values: NewMission): Promise<Mission> {
  const [created] = await db.insert(missions).values(values).returning();
  if (!created) throw new Error('workspace mission insert returned no rows');
  return created;
}

const defaultDeps: WorkspaceMissionDeps = {
  findExisting: dbFindExistingWorkspaceMission,
  insertMission: dbInsertMission,
};

/**
 * Get the repo's standing triage Mission for this user, creating it if none
 * exists. Standing missions start `running` immediately — there is no
 * draft/plan phase; per-issue "Work on it" opt-in replaces plan review. The
 * reconciler must never auto-complete a mission with `workspaceRepo` set
 * (see apps/tick/src/reconciler.ts).
 */
export async function getOrCreateWorkspaceMission(
  userId: string,
  repo: string,
  defaults: MissionDefaults,
  deps: WorkspaceMissionDeps = defaultDeps,
): Promise<Mission> {
  const existing = await deps.findExisting(userId, repo);
  if (existing) return existing;

  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: `Issues — ${repo}`,
    goal: `Triage open issues in ${repo}.`,
    status: 'running',
    backend: 'managed-agents',
    agentId: defaults.agentId ?? '',
    plannerStrategy: 'triage',
    targetRepos: [repo],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    budgetHardStopPct: 100,
    taskMaxTurns: null,
    taskMaxTokens: null,
    noProgressTokens: null,
    webhookSecret: randomBytes(32).toString('hex'),
    githubInstallationId: defaults.githubInstallationId,
    githubVaultId: defaults.githubVaultId,
    skillId: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    workspaceRepo: repo,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };

  return deps.insertMission(values);
}
