'use server';

import { randomBytes, randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import {
  githubInstallationRepos,
  githubInstallations,
  ledgerEvents,
  missions,
  skills,
  tasks,
} from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export type ChatSessionResult = {
  missionId: string;
  missionName: string;
  taskId: string;
  repo: string;
};

export type SkillSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export async function listSkills(): Promise<SkillSummary[]> {
  try {
    const rows = await db
      .select({
        id: skills.id,
        name: skills.name,
        slug: skills.slug,
        description: skills.description,
      })
      .from(skills)
      .limit(50);
    return rows;
  } catch {
    return [];
  }
}

/**
 * Create a mission from a chat message. Uses the user's first connected repo;
 * errors if no repo is connected.
 */
export async function createSessionFromChat(
  message: string,
  skillSlug?: string | null,
): Promise<ChatSessionResult> {
  const user = await withAuth();

  // Find the user's connected repos (table may not exist in dev)
  let connectedRepos: { repo: string; agentId: string | null; githubVaultId: string | null }[] = [];
  try {
    connectedRepos = await db
      .select({
        repo: githubInstallationRepos.repo,
        agentId: githubInstallations.agentId,
        githubVaultId: githubInstallations.githubVaultId,
      })
      .from(githubInstallationRepos)
      .innerJoin(
        githubInstallations,
        eq(githubInstallationRepos.installationId, githubInstallations.id),
      )
      .where(eq(githubInstallations.userId, user.id))
      .limit(10);
  } catch {
    // Table doesn't exist yet — fall back to defaults
  }

  const repo = connectedRepos[0]?.repo;
  if (!repo) {
    throw new Error('No connected repositories. Connect a repo in /setup before creating a mission.');
  }
  const agentId =
    connectedRepos[0]?.agentId ?? env.FORGE_DEFAULT_AGENT_ID ?? 'agent_unset';
  const githubVaultId =
    connectedRepos[0]?.githubVaultId ??
    env.FORGE_DEFAULT_GITHUB_VAULT_ID ??
    null;

  // Resolve skill ID from slug
  let skillId: string | null = null;
  if (skillSlug) {
    const [skill] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, skillSlug))
      .limit(1);
    skillId = skill?.id ?? null;
  }

  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const missionName = message.split('\n')[0]?.slice(0, 80) ?? 'chat session';

  await db.transaction(async (tx) => {
    await tx.insert(missions).values({
      id: missionId,
      userId: user.id,
      name: missionName,
      goal: `IMPORTANT: The repo is cloned at /mnt/session/resources/repo_0 — cd there first.\n\n${message}`,
      status: 'running',
      backend: env.FORGE_BACKEND,
      agentId,
      plannerStrategy: 'rule-based',
      targetRepos: [repo],
      concurrencyCap: 1,
      webhookSecret: randomBytes(32).toString('hex'),
      githubInstallationId: 'chat',
      githubVaultId,
      skillId,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    });

    await tx.insert(tasks).values({
      id: taskId,
      missionId,
      repo,
      baseBranch: 'main',
      promptVars: { repo, base_branch: 'main' },
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(ledgerEvents).values([
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId,
        eventType: 'mission.created_from_chat',
        payload: { message, repo, triggeredBy: user.email },
        createdAt: now,
      },
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId,
        taskId,
        eventType: 'planner.emitted',
        payload: { strategy: 'rule-based', taskIds: [taskId], source: 'chat' },
        createdAt: now,
      },
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId,
        eventType: 'mission.started',
        payload: { from: 'planning', to: 'running', source: 'chat' },
        createdAt: now,
      },
    ]);
  });

  return { missionId, missionName, taskId, repo };
}
