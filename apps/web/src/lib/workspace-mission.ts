import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';

import { missions, type Mission, type NewMission } from '@forge/db';

import { db } from './db';
import type { MissionDefaults } from './mission-defaults';

export type WorkspaceMissionDeps = {
  findExisting: (userId: string, repo: string) => Promise<Mission | null>;
  insertMission: (values: NewMission) => Promise<Mission>;
};

/**
 * Find a repo's container Mission for this user — the pure budget/
 * concurrency envelope (workspaceRepo set, issueRef null, parentMissionId
 * null, owns zero tasks). The issueRef/parentMissionId IS NULL conditions
 * below are load-bearing, not redundant with the status filter: a repo's
 * issue leaf missions also have `workspaceRepo` set to this same repo, and
 * are typically non-terminal (`running`) for as long as the container is.
 * Without excluding leaves explicitly, `ORDER BY createdAt DESC LIMIT 1`
 * would return whichever issue leaf was created most recently — not the
 * container — as soon as the repo had more than one issue ever worked in
 * it, since leaves are always created after their container.
 */
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
        isNull(missions.issueRef),
        isNull(missions.parentMissionId),
        notInArray(missions.status, ['completed', 'cancelled']),
      ),
    )
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Read-only lookup for a repo's standing triage Mission, for use on page
 * loads. Unlike `getOrCreateWorkspaceMission`, this never creates one —
 * viewing a page isn't "Work on it". "No mission yet" just means no issues
 * in this repo have been worked on.
 */
export async function findWorkspaceMission(userId: string, repo: string): Promise<Mission | null> {
  return dbFindExistingWorkspaceMission(userId, repo);
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
 * Get the repo's container Mission for this user, creating it if none
 * exists. A container never owns tasks and is never listed anywhere — it
 * exists only to hold the repo-wide `concurrencyCap`/budget that its issue
 * leaf missions (see `getOrCreateIssueMission`) share. The reconciler must
 * never auto-complete a container — see reconciler.ts.
 */
export async function getOrCreateWorkspaceMission(
  userId: string,
  repo: string,
  defaults: MissionDefaults,
  deps: WorkspaceMissionDeps = defaultDeps,
): Promise<Mission> {
  const existing = await deps.findExisting(userId, repo);
  if (existing) return existing;

  if (!defaults.agentId) {
    throw new Error(
      'No agent configured. Connect GitHub in Setup, or set FORGE_DEFAULT_AGENT_ID.',
    );
  }

  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: `Issues — ${repo}`,
    goal: `Triage open issues in ${repo}.`,
    status: 'running',
    backend: 'managed-agents',
    agentId: defaults.agentId,
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

export async function dbFindExistingIssueMission(
  userId: string,
  repo: string,
  issueRef: string,
): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        eq(missions.workspaceRepo, repo),
        eq(missions.issueRef, issueRef),
      ),
    )
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function dbReopenMission(id: string): Promise<Mission> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: 'running', completedAt: null, updatedAt: now })
    .where(eq(missions.id, id))
    .returning();
  if (!updated) throw new Error(`reopenMission: mission ${id} not found`);
  return updated;
}

export type IssueMissionDeps = {
  findExistingIssue: (userId: string, repo: string, issueRef: string) => Promise<Mission | null>;
  reopenMission: (id: string) => Promise<Mission>;
  getOrCreateContainer: (userId: string, repo: string, defaults: MissionDefaults) => Promise<Mission>;
  insertMission: (values: NewMission) => Promise<Mission>;
};

const defaultIssueMissionDeps: IssueMissionDeps = {
  findExistingIssue: dbFindExistingIssueMission,
  reopenMission: dbReopenMission,
  getOrCreateContainer: getOrCreateWorkspaceMission,
  insertMission: dbInsertMission,
};

/**
 * Get, reopen, or create the Mission for one specific issue in a repo.
 * Creates the repo's container Mission first if this is the first issue
 * ever worked there. "Work again" on an issue whose mission already
 * reached a terminal state reopens that same mission rather than minting
 * a new one — an issue's full work history lives in one place.
 */
export async function getOrCreateIssueMission(
  userId: string,
  repo: string,
  issueRef: string,
  defaults: MissionDefaults,
  deps: IssueMissionDeps = defaultIssueMissionDeps,
): Promise<Mission> {
  const existing = await deps.findExistingIssue(userId, repo, issueRef);
  if (existing) {
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return deps.reopenMission(existing.id);
    }
    return existing;
  }

  const container = await deps.getOrCreateContainer(userId, repo, defaults);

  if (!defaults.agentId) {
    throw new Error(
      'No agent configured. Connect GitHub in Setup, or set FORGE_DEFAULT_AGENT_ID.',
    );
  }

  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: `Issue — ${issueRef}`,
    goal: `Fix ${issueRef} in ${repo}.`,
    status: 'running',
    backend: 'managed-agents',
    agentId: defaults.agentId,
    plannerStrategy: 'rule-based',
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
    issueRef,
    parentMissionId: container.id,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };

  return deps.insertMission(values);
}
