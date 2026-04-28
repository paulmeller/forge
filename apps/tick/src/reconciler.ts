import { randomUUID } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type Mission,
  type TaskStatus,
} from '@forge/db';

import { db } from './db';
import { env } from './env';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type ReconcileResult = {
  missionsChecked: number;
  missionsCompleted: number;
  tasksAbandoned: number;
  tasksCascadeFailed: number;
  prsOpened: number;
};

export const DEPENDENCY_FAILED_STATUSES: TaskStatus[] = ['failed', 'abandoned'];

const MISSION_TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'merged',
  'awaiting_review',
  'abandoned',
  'failed',
];

/**
 * Close out Missions whose Tasks have all settled, and clean up Tasks that
 * stalled in turn_ended with no PR (agent produced no diff — PRD §7.5).
 *
 * Called by the tick after the poller so fresh state transitions from this
 * tick feed into the completion check.
 */
export async function runReconciler(log: Logger): Promise<ReconcileResult> {
  let tasksAbandoned = 0;
  let missionsCompleted = 0;

  // (0) Cascade-fail queued tasks whose dependencies have failed/abandoned.
  let tasksCascadeFailed = 0;
  const blocked = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'queued'), isNotNull(tasks.dependsOnIds)));

  for (const task of blocked) {
    const depIds = (task.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) continue;

    const [failedDeps] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(inArray(tasks.id, depIds), inArray(tasks.status, DEPENDENCY_FAILED_STATUSES)));

    if (Number(failedDeps?.count ?? 0) > 0) {
      const now = new Date();
      await db
        .update(tasks)
        .set({
          status: 'failed',
          lastError: 'upstream dependency failed',
          updatedAt: now,
          completedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'queued')));
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.dependency_failed',
        payload: { dependsOnIds: depIds },
        createdAt: now,
      });
      tasksCascadeFailed += 1;
      log.info({ taskId: task.id }, 'reconciler:dependency_failed');
    }
  }

  // (1) turn_ended with no PR → try to open a PR via Octokit.
  // The agent pushed a branch but didn't open a PR (common with Codex/OpenCode
  // which don't have MCP tools). Forge opens the PR on their behalf.
  // If no branch was pushed, abandon the task.
  let prsOpened = 0;
  const stalled = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'turn_ended'), isNull(tasks.prUrl)));

  for (const task of stalled) {
    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, task.missionId))
      .limit(1);
    if (!mission) continue;

    const opened = await tryOpenPr(task, mission, log);
    if (opened) {
      prsOpened += 1;
    } else {
      const now = new Date();
      await db
        .update(tasks)
        .set({ status: 'abandoned', updatedAt: now, completedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'turn_ended')));
      await db.insert(ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: task.missionId,
        taskId: task.id,
        eventType: 'task.abandoned',
        payload: { reason: 'turn_ended with no PR and no branch found' },
        createdAt: now,
      });
      tasksAbandoned += 1;
      log.info({ taskId: task.id }, 'reconciler:task_abandoned');
    }
  }

  // (2) Complete Missions whose tasks are all in terminal states.
  const candidates = await db
    .select()
    .from(missions)
    .where(eq(missions.status, 'running'));

  for (const mission of candidates) {
    const nonTerminal = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.missionId, mission.id),
          notInArray(tasks.status, MISSION_TERMINAL_TASK_STATUSES),
        ),
      );
    const remaining = Number(nonTerminal[0]?.count ?? 0);
    if (remaining > 0) continue;

    const anyTasks = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.missionId, mission.id));
    if (Number(anyTasks[0]?.count ?? 0) === 0) continue; // Mission with zero tasks — leave alone

    await completeMission(mission);
    missionsCompleted += 1;
    log.info({ missionId: mission.id }, 'reconciler:mission_completed');
  }

  return { missionsChecked: candidates.length, missionsCompleted, tasksAbandoned, tasksCascadeFailed, prsOpened };
}

let octokit: Octokit | undefined;
function gh(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) throw new Error('GITHUB_APP_TOKEN not configured');
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

/**
 * After an agent pushes a branch but doesn't open a PR, Forge opens one.
 * Looks for branches matching common patterns (forge/*, feat/issue-*).
 * Returns true if a PR was opened, false if no branch found.
 */
async function tryOpenPr(
  task: typeof tasks.$inferSelect,
  mission: typeof missions.$inferSelect,
  log: Logger,
): Promise<boolean> {
  const [owner, repo] = task.repo.split('/');
  if (!owner || !repo) return false;

  try {
    // Look for branches the agent might have pushed
    const candidates = [
      `forge/${task.id}`,
      `feat/issue-${task.issueRef?.split('#')[1] ?? ''}`,
      `forge/fix-${task.id.slice(4, 12)}`,
    ].filter((b) => b && !b.endsWith('-') && !b.endsWith('/'));

    // Also check for any branch pushed in the last 10 minutes
    const { data: branches } = await gh().repos.listBranches({ owner, repo, per_page: 30 });
    const defaultBranch = task.baseBranch || 'main';
    const recentBranches = branches
      .filter((b) => b.name !== defaultBranch)
      .map((b) => b.name);

    // Try candidates first, then any non-default branch
    const allCandidates = [...new Set([...candidates, ...recentBranches])];

    for (const branch of allCandidates) {
      try {
        // Check if this branch has commits ahead of the default branch
        const { data: comparison } = await gh().repos.compareCommits({
          owner,
          repo,
          base: defaultBranch,
          head: branch,
        });
        if (comparison.ahead_by === 0) continue;

        // Check if a PR already exists for this branch
        const { data: existingPrs } = await gh().pulls.list({
          owner,
          repo,
          head: `${owner}:${branch}`,
          state: 'open',
        });
        if (existingPrs.length > 0) {
          // PR already exists — just record it
          const pr = existingPrs[0]!;
          const now = new Date();
          await db
            .update(tasks)
            .set({
              status: 'awaiting_ci',
              prUrl: pr.html_url,
              prNumber: pr.number,
              diffAdditions: comparison.total_commits,
              updatedAt: now,
            })
            .where(eq(tasks.id, task.id));
          log.info({ taskId: task.id, prNumber: pr.number }, 'reconciler:existing_pr_found');
          return true;
        }

        // Open a new PR
        const title = mission.name.startsWith('GH:')
          ? mission.name.replace(/^GH:\s*\S+\s*—\s*/, '')
          : `Forge: ${mission.name}`;

        const { data: pr } = await gh().pulls.create({
          owner,
          repo,
          title,
          body: `Automated by Forge.\n\nMission: ${mission.name}\nTask: ${task.id}\nBranch: ${branch}`,
          head: branch,
          base: defaultBranch,
        });

        const now = new Date();
        await db
          .update(tasks)
          .set({
            status: 'awaiting_ci',
            prUrl: pr.html_url,
            prNumber: pr.number,
            diffAdditions: comparison.files?.length ?? 0,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id));

        await db.insert(ledgerEvents).values({
          id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          missionId: mission.id,
          taskId: task.id,
          eventType: 'gate.pr_opened',
          payload: {
            prNumber: pr.number,
            prUrl: pr.html_url,
            branch,
            aheadBy: comparison.ahead_by,
            openedBy: 'forge-reconciler',
          },
          createdAt: now,
        });

        log.info({ taskId: task.id, prNumber: pr.number, branch }, 'reconciler:pr_opened');
        return true;
      } catch {
        // Branch doesn't exist or comparison failed — try next
        continue;
      }
    }
  } catch (err) {
    log.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'reconciler:pr_open_failed',
    );
  }
  return false;
}

async function completeMission(mission: Mission): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(missions.id, mission.id), eq(missions.status, 'running')))
    .returning();
  if (!updated) return; // lost the race; fine

  const [counts] = await db
    .select({
      merged: sql<number>`sum(case when ${tasks.status} = 'merged' then 1 else 0 end)`,
      awaitingReview: sql<number>`sum(case when ${tasks.status} = 'awaiting_review' then 1 else 0 end)`,
      abandoned: sql<number>`sum(case when ${tasks.status} = 'abandoned' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${tasks.status} = 'failed' then 1 else 0 end)`,
    })
    .from(tasks)
    .where(eq(tasks.missionId, mission.id));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'mission.completed',
    payload: {
      merged: Number(counts?.merged ?? 0),
      awaitingReview: Number(counts?.awaitingReview ?? 0),
      abandoned: Number(counts?.abandoned ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    createdAt: now,
  });
}

// Re-exported for test visibility.
export { MISSION_TERMINAL_TASK_STATUSES }; // DEPENDENCY_FAILED_STATUSES is already exported above
