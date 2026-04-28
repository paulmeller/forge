import { randomBytes, randomUUID } from 'node:crypto';

import { ledgerEvents, missions, tasks, type Mission } from '@forge/db';

import { db } from './db';
import { env } from './env';

export type GithubDispatchInput = {
  repoFullName: string; // 'owner/repo'
  defaultBranch: string;
  goal: string; // free-form text from the comment
  issueRef?: string; // 'owner/repo#123'
  triggeredBy: string; // GitHub login of the commenter
};

export type GithubDispatchResult = {
  mission: Mission;
  taskId: string;
};

// GitHub-dispatched missions use a system user ID since there's no
// authenticated session context in webhook handlers.
const GITHUB_SYSTEM_USER_ID = 'user_default';

/**
 * Spawns a one-Task Mission scoped to a single repo, kicked off by a
 * GitHub @-mention or reaction. Mission goes draft → planning → running
 * in one shot since the operator already gave the command externally.
 */
export async function dispatchFromGithub(
  input: GithubDispatchInput,
): Promise<GithubDispatchResult> {
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const ledgerSeed = `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  return db.transaction(async (tx) => {
    const [mission] = await tx
      .insert(missions)
      .values({
        id: missionId,
        userId: GITHUB_SYSTEM_USER_ID,
        name: `GH: ${input.repoFullName} — ${input.goal.split('\n')[0]?.slice(0, 60) ?? 'mission'}`,
        goal: `IMPORTANT: The repo is cloned at /mnt/session/resources/repo_0 — cd there first.\n\n${input.goal}`,
        status: 'running',
        backend: env.FORGE_BACKEND,
        agentId: env.FORGE_DEFAULT_AGENT_ID ?? 'agent_unset',
        plannerStrategy: 'rule-based',
        targetRepos: [input.repoFullName],
        concurrencyCap: 1,
        budgetUsd: null,
        budgetTokens: null,
        budgetThresholdPct: 80,
        webhookSecret: randomBytes(32).toString('hex'),
        githubInstallationId: 'gh-webhook',
        githubVaultId: env.FORGE_DEFAULT_GITHUB_VAULT_ID ?? null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      })
      .returning();
    if (!mission) throw new Error('mission insert returned no rows');

    await tx.insert(tasks).values({
      id: taskId,
      missionId: mission.id,
      repo: input.repoFullName,
      baseBranch: input.defaultBranch,
      promptVars: { repo: input.repoFullName, base_branch: input.defaultBranch },
      issueRef: input.issueRef ?? null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(ledgerEvents).values([
      {
        id: ledgerSeed,
        missionId: mission.id,
        eventType: 'mission.created_from_github',
        payload: {
          repo: input.repoFullName,
          issueRef: input.issueRef,
          triggeredBy: input.triggeredBy,
          goal: input.goal,
        },
        createdAt: now,
      },
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: mission.id,
        taskId,
        eventType: 'planner.emitted',
        payload: {
          strategy: 'rule-based',
          taskIds: [taskId],
          repoCount: 1,
          source: 'github',
        },
        createdAt: now,
      },
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: mission.id,
        eventType: 'mission.started',
        payload: { from: 'planning', to: 'running', source: 'github' },
        createdAt: now,
      },
    ]);

    return { mission, taskId };
  });
}

/**
 * Parse a comment body for the @forge directive. Returns the goal text or
 * null if the comment isn't a Forge command.
 *
 * Supported shapes:
 *   "@forge bump fast-glob to ^3.3.2"
 *   "/forge add OTel spans to every HTTP handler"
 */
const TRIGGER = /^\s*(?:@forge|\/forge)\b\s*(.*)$/i;

export function parseForgeDirective(body: string | null | undefined): string | null {
  if (!body) return null;
  // Allow the directive to be on any line of the comment.
  for (const line of body.split(/\r?\n/)) {
    const m = TRIGGER.exec(line);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}
