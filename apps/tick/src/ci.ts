import { randomUUID } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { getAdapter } from './adapters';
import { db } from './db';
import { env } from './env';
import { postCiStatus } from './gates';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type CiResult = {
  tasksChecked: number;
  transitionedToReview: number;
  transitionedToFailed: number;
  retried: number;
  stillPending: number;
};

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

let octokit: Octokit | undefined;
function client(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) throw new Error('GITHUB_APP_TOKEN not configured');
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

export async function runCiPoller(log: Logger): Promise<CiResult> {
  const awaiting = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'awaiting_ci'), isNotNull(tasks.prUrl)));

  let review = 0;
  let failed = 0;
  let retried = 0;
  let pending = 0;

  for (const task of awaiting) {
    try {
      const outcome = await checkOne(task);
      if (outcome === 'success') review += 1;
      else if (outcome === 'failure') failed += 1;
      else if (outcome === 'retry') retried += 1;
      else pending += 1;
    } catch (err) {
      pending += 1;
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'ci:check_failed',
      );
    }
  }

  return {
    tasksChecked: awaiting.length,
    transitionedToReview: review,
    transitionedToFailed: failed,
    retried,
    stillPending: pending,
  };
}

type Outcome = 'success' | 'failure' | 'retry' | 'pending';

export type FailedCheck = {
  name: string;
  conclusion: string;
  detailsUrl?: string;
  output?: { title?: string | null; summary?: string | null };
};

async function checkOne(task: Task): Promise<Outcome> {
  if (!task.prUrl) return 'pending';
  const m = PR_URL_RE.exec(task.prUrl);
  if (!m) return 'pending';
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return 'pending';
  const pullNumber = Number(pullStr);

  // Look up mission gate config (AI review + self-verify) to route green CI.
  const [missionRow] = await db
    .select({
      aiReviewEnabled: missions.aiReviewEnabled,
      selfVerifyEnabled: missions.selfVerifyEnabled,
    })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  const nextReviewStatus = postCiStatus({
    selfVerifyEnabled: missionRow?.selfVerifyEnabled ?? false,
    hasAcceptanceCriteria: task.acceptanceCriteria != null,
    aiReviewEnabled: missionRow?.aiReviewEnabled ?? false,
  });

  const gh = client();
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: pullNumber });
  const sha = pr.head.sha;

  const { data: checks } = await gh.checks.listForRef({ owner, repo, ref: sha, per_page: 100 });
  if (checks.total_count === 0) {
    await transitionToReview(
      task,
      { sha, checksTotal: 0, verdict: 'no-checks-success' },
      nextReviewStatus,
    );
    return 'success';
  }

  const allComplete = checks.check_runs.every((c) => c.status === 'completed');
  if (!allComplete) return 'pending';

  const failedRuns: FailedCheck[] = checks.check_runs
    .filter(
      (c) =>
        c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled',
    )
    .map((c) => ({
      name: c.name,
      conclusion: c.conclusion ?? 'unknown',
      detailsUrl: c.details_url ?? undefined,
      output: c.output ? { title: c.output.title, summary: c.output.summary } : undefined,
    }));

  if (failedRuns.length > 0) {
    // Phase 2 retry-with-feedback (PRD §7.5):
    //   if retry_count < TASK_RETRY_MAX, send a follow-up turn to the same
    //   session with the failing log; the agent fixes; CI re-runs.
    //   The Task stays at awaiting_ci while the agent works (its session
    //   transitions running → idle → running).
    const max = env.TASK_RETRY_MAX;
    if (task.retryCount < max && task.sessionId) {
      const sent = await retryWithFeedback(task, failedRuns, sha);
      if (sent) return 'retry';
      // sendTurn failed for some reason — fall through to mark failed.
    }

    await transitionToFailed(
      task,
      {
        sha,
        failedChecks: failedRuns.map((r) => `${r.name}:${r.conclusion}`),
        retriesExhausted: task.retryCount >= env.TASK_RETRY_MAX,
      },
      `CI failed: ${failedRuns.map((r) => r.name).join(', ')}`,
    );
    return 'failure';
  }

  const allSuccess = checks.check_runs.every(
    (c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral',
  );
  if (allSuccess) {
    await transitionToReview(
      task,
      { sha, checksTotal: checks.total_count, verdict: 'all-passed' },
      nextReviewStatus,
    );
    return 'success';
  }
  return 'pending';
}

/**
 * Build the retry-with-feedback prompt sent to the agent. Pure function,
 * exported for testing.
 */
export function buildRetryPrompt(sha: string, failedChecks: FailedCheck[]): string {
  const summary = failedChecks
    .map((c) => {
      const out = [c.output?.title, c.output?.summary].filter(Boolean).join(' — ');
      return `- ${c.name} (${c.conclusion})${out ? `: ${out}` : ''}${c.detailsUrl ? ` [${c.detailsUrl}]` : ''}`;
    })
    .join('\n');

  return `CI failed on the PR you opened. Sha: ${sha}.\n\nFailing checks:\n${summary}\n\nPlease investigate the logs at the linked URLs (use the github MCP get_workflow_run_logs tool if available, otherwise read the linked details), fix the issue on the same branch, and push the fix. Reply when done.`;
}

async function retryWithFeedback(
  task: Task,
  failedChecks: FailedCheck[],
  sha: string,
): Promise<boolean> {
  if (!task.sessionId) return false;

  const [mission] = await db
    .select({ backend: missions.backend })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  if (!mission) return false;

  const prompt = buildRetryPrompt(sha, failedChecks);

  try {
    const adapter = getAdapter(mission.backend);
    await adapter.sendTurn(task.sessionId, prompt);
  } catch {
    return false;
  }

  const now = new Date();
  await db
    .update(tasks)
    .set({
      retryCount: task.retryCount + 1,
      // Stay at awaiting_ci — once the agent pushes, GitHub will trigger a
      // new check run and we'll re-evaluate on the next ci poll.
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ci.retry_dispatched',
    payload: {
      sha,
      retryCount: task.retryCount + 1,
      maxRetries: env.TASK_RETRY_MAX,
      failedChecks: failedChecks.map((c) => c.name),
    },
    createdAt: now,
  });
  return true;
}

async function transitionToReview(
  task: Task,
  payload: Record<string, unknown>,
  targetStatus: 'awaiting_review' | 'awaiting_ai_review' | 'awaiting_verify' = 'awaiting_review',
): Promise<void> {
  const now = new Date();
  await db.update(tasks).set({ status: targetStatus, updatedAt: now }).where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ci.passed',
    payload,
    createdAt: now,
  });
}

async function transitionToFailed(
  task: Task,
  payload: Record<string, unknown>,
  lastError: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: 'failed', lastError, updatedAt: now, completedAt: now })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ci.failed',
    payload,
    createdAt: now,
  });
}
