import { randomBytes, randomUUID } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { eq } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, ledgerEvents, missions, tasks, type Mission } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { runPlanner } from './planner';
import { getRepoPolicy } from './repo-policy';

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
 * GitHub @-mention or reaction.
 *
 * Whether it runs immediately depends on the repo's `requirePlanApproval`
 * policy, which defaults to true. An @-mention is a request, not plan
 * approval — the UI path has always required a human to review the plan
 * before dispatch, and this is what stops @forge being the one way in that
 * skips that gate.
 */
export async function dispatchFromGithub(
  input: GithubDispatchInput,
): Promise<GithubDispatchResult> {
  const policy = await getRepoPolicy(input.repoFullName);
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const ledgerSeed = `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  // Look up the repo owner from github_installation_repos
  const [repoRow] = await db
    .select({
      userId: githubInstallations.userId,
      agentId: githubInstallations.agentId,
      githubVaultId: githubInstallations.githubVaultId,
    })
    .from(githubInstallationRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallationRepos.installationId, githubInstallations.id),
    )
    .where(eq(githubInstallationRepos.repo, input.repoFullName))
    .limit(1);

  const userId = repoRow?.userId ?? GITHUB_SYSTEM_USER_ID;
  const agentId = repoRow?.agentId ?? env.FORGE_DEFAULT_AGENT_ID ?? 'agent_unset';
  const githubVaultId = repoRow?.githubVaultId ?? env.FORGE_DEFAULT_GITHUB_VAULT_ID ?? null;

  const created = await db.transaction(async (tx) => {
    const [mission] = await tx
      .insert(missions)
      .values({
        id: missionId,
        userId,
        name: `GH: ${input.repoFullName} — ${input.goal.split('\n')[0]?.slice(0, 60) ?? 'mission'}`,
        goal: `IMPORTANT: The repo is cloned at /mnt/session/resources/repo_0 — cd there first.\n\n${input.goal}`,
        status: policy.requirePlanApproval ? 'draft' : 'running',
        backend: env.FORGE_BACKEND,
        agentId,
        plannerStrategy: 'rule-based',
        targetRepos: [input.repoFullName],
        concurrencyCap: 1,
        budgetUsd: null,
        budgetTokens: null,
        budgetThresholdPct: 80,
        webhookSecret: randomBytes(32).toString('hex'),
        githubInstallationId: 'gh-webhook',
        githubVaultId,
        createdAt: now,
        updatedAt: now,
        startedAt: policy.requirePlanApproval ? null : now,
      })
      .returning();
    if (!mission) throw new Error('mission insert returned no rows');

    await tx.insert(ledgerEvents).values({
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
    });

    // Gated (requirePlanApproval): leave the Mission in `draft` with no
    // Tasks — runPlanner (called below, once the transaction has committed)
    // is what creates them. Inserting a placeholder Task here too would
    // leave a gated Mission with two Tasks, breaking the "one-Task Mission"
    // invariant this function's callers (and the dispatcher) rely on.
    if (policy.requirePlanApproval) {
      return { mission, taskId: null as string | null };
    }

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
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

  if (!policy.requirePlanApproval) {
    // created.taskId is always set on this branch (see above).
    return { mission: created.mission, taskId: created.taskId! };
  }

  // Plan now so the operator reviews real Tasks rather than an empty
  // mission; startMission() remains the only path to `running`.
  const plan = await runPlanner(created.mission.id);
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.missionId, created.mission.id))
    .limit(1);
  await commentPlanLink(input, created.mission.id);

  return { mission: plan.mission, taskId: task?.id ?? '' };
}

const ISSUE_REF_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/**
 * Tells the commenter where to approve the plan. Best-effort: a failure to
 * comment must not undo a Mission that was created successfully, so this
 * swallows errors rather than throwing into the dispatch path.
 */
async function commentPlanLink(input: GithubDispatchInput, missionId: string): Promise<void> {
  if (!input.issueRef || !env.GITHUB_APP_TOKEN || !env.BETTER_AUTH_URL) return;
  const m = ISSUE_REF_RE.exec(input.issueRef);
  if (!m) return;
  const [, owner, repo, numStr] = m;
  try {
    await new Octokit({ auth: env.GITHUB_APP_TOKEN }).issues.createComment({
      owner: owner!,
      repo: repo!,
      issue_number: Number(numStr),
      body:
        `Planned this mission. Review and approve it to start: ` +
        `${env.BETTER_AUTH_URL}/missions/${missionId}/plan`,
    });
  } catch {
    // Non-fatal — the Mission exists and is visible in the UI regardless.
  }
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
