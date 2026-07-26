import { randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { getAdapter } from './adapters';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { resolveGateFlags } from './gate-flags';
import { afterVerifyStatus } from './gates';
import { getSkill } from './skill-loader';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type VerifyResult = {
  tasksChecked: number;
  passed: number;
  retried: number;
  escalated: number;
  skipped: number;
  errors: number;
};

export type Verdict = { verdict: 'done' | 'incomplete'; missing?: string };

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const MAX_DIFF_CHARS = 50_000;

let octokit: Octokit | undefined;
function ghClient(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) throw new Error('GITHUB_APP_TOKEN not configured');
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

/**
 * Build the done-check prompt. Pure function, exported for testing. This is the
 * `/goal` validator: does the diff actually satisfy the acceptance criteria?
 */
export function buildVerifyPrompt(acceptanceCriteria: string, diff: string): string {
  const truncated = diff.length > MAX_DIFF_CHARS ? '\n[diff truncated]' : '';
  return `You are verifying whether a pull request opened by an AI agent is actually DONE — i.e. whether it satisfies its acceptance criteria. You are NOT reviewing code quality; a separate gate does that. Judge completeness only.

## Acceptance Criteria

${acceptanceCriteria}

## PR Diff

\`\`\`diff
${diff.slice(0, MAX_DIFF_CHARS)}${truncated}
\`\`\``;
}

const VerdictSchema = z.object({
  verdict: z.enum(['done', 'incomplete']),
  missing: z.string().optional(),
});

/**
 * Ask the checker model whether a diff satisfies its acceptance criteria.
 * Never throws for a malformed model response — falls back to `incomplete`,
 * matching the "never silently passes a Task as done" invariant.
 */
export async function requestVerdict(opts: {
  acceptanceCriteria: string;
  diff: string;
  model: string;
}): Promise<{ verdict: Verdict; tokensUsed: number }> {
  const prompt = buildVerifyPrompt(opts.acceptanceCriteria, opts.diff);
  try {
    const { object, usage } = await generateObject({
      model: anthropic(opts.model),
      schema: VerdictSchema,
      prompt,
    });
    return {
      verdict: object,
      tokensUsed: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return {
        verdict: {
          verdict: 'incomplete',
          missing: `unparseable verifier response: ${(error.text ?? '').slice(0, 200)}`,
        },
        tokensUsed: (error.usage?.inputTokens ?? 0) + (error.usage?.outputTokens ?? 0),
      };
    }
    throw error;
  }
}

/**
 * Build the feedback turn sent back to the agent when the work is incomplete.
 * Pure function, exported for testing.
 */
export function buildVerifyFeedback(missing: string): string {
  return `Your PR does not yet meet the task's acceptance criteria. Still missing:\n\n${missing}\n\nPlease address this on the same branch and push the fix. Reply when done.`;
}

/**
 * Tick subsystem: the self-verification gate. For each `awaiting_verify` Task,
 * grade the PR diff against its acceptance criteria with a checker model that is
 * deliberately NOT the maker, then advance / retry / escalate. `VERIFY_RETRY_MAX`
 * is the only bound on the loop (spec §3.2).
 */
export async function runVerify(log: Logger): Promise<VerifyResult> {
  const awaiting = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'awaiting_verify'), isNotNull(tasks.prUrl)));

  const result: VerifyResult = {
    tasksChecked: awaiting.length,
    passed: 0,
    retried: 0,
    escalated: 0,
    skipped: 0,
    errors: 0,
  };

  for (const task of awaiting) {
    try {
      const outcome = await verifyOne(task, log);
      if (outcome === 'passed') result.passed += 1;
      else if (outcome === 'retried') result.retried += 1;
      else if (outcome === 'escalated') result.escalated += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errors += 1;
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'verify:check_failed',
      );
    }
  }

  return result;
}

type VerifyOutcome = 'passed' | 'retried' | 'escalated' | 'skipped';

async function verifyOne(task: Task, log: Logger): Promise<VerifyOutcome> {
  if (!task.prUrl || !task.acceptanceCriteria) {
    // No criteria → nothing to check; hand off to human review.
    await escalate(task, task.costTokens, 'no acceptance criteria', { reason: 'no_criteria' });
    return 'escalated';
  }

  const m = PR_URL_RE.exec(task.prUrl);
  if (!m) return 'skipped';
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return 'skipped';
  const pullNumber = Number(pullStr);

  const [mission] = await db
    .select({
      backend: missions.backend,
      skillId: missions.skillId,
    })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  if (!mission) throw new Error(`mission ${task.missionId} not found`);
  // AI-review flag resolved via the container for issue leaves — see resolveGateFlags.
  const { aiReviewEnabled } = await resolveGateFlags(task.missionId);

  const gh = ghClient();
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: pullNumber });
  const headSha = pr.head.sha;

  // No-push guard: if HEAD hasn't moved since we last graded this Task, the agent
  // ignored the feedback — escalate rather than re-grade the identical diff. This
  // bounds the no-push case to ZERO extra validator calls and sidesteps the
  // unobservable "is a push in flight?" on CI-less repos (spec §3.2).
  if (task.lastVerifiedSha && task.lastVerifiedSha === headSha) {
    await escalate(task, task.costTokens, 'no new commit after verify feedback', {
      reason: 'no_new_push',
      sha: headSha,
    });
    return 'escalated';
  }

  // Stale-diff guard: if checks for the current HEAD aren't complete yet, wait —
  // don't grade a half-pushed diff. (No checks at all → nothing to wait on.)
  const { data: checks } = await gh.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 });
  if (checks.total_count > 0 && !checks.check_runs.every((c) => c.status === 'completed')) {
    return 'skipped';
  }

  // Grade a genuinely new SHA.
  const diffResponse = await gh.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  });
  const diff = String(diffResponse.data);

  // Checker ≠ maker: a different (configurable, cheaper-by-default) model.
  let verifyModel = env.VERIFY_MODEL;
  if (mission.skillId) {
    const skill = await getSkill(mission.skillId);
    if (skill?.loopPolicy?.verifyModel) verifyModel = skill.loopPolicy.verifyModel;
  }

  const { verdict, tokensUsed } = await requestVerdict({
    acceptanceCriteria: task.acceptanceCriteria,
    diff,
    model: verifyModel,
  });

  const newCostTokens = task.costTokens + tokensUsed;

  log.info(
    { taskId: task.id, verdict: verdict.verdict, tokens: tokensUsed, model: verifyModel },
    'verify:decision',
  );

  if (verdict.verdict === 'done') {
    await pass(task, newCostTokens, headSha, aiReviewEnabled, { pullNumber, sha: headSha });
    return 'passed';
  }

  // Incomplete.
  if (task.verifyRetryCount < env.VERIFY_RETRY_MAX && task.sessionId) {
    if (task.sessionId) {
      try {
        const result = await getAdapter(mission.backend).sendTurn({
          sessionId: task.sessionId,
          text: buildVerifyFeedback(verdict.missing ?? ''),
          backendSessionRef: task.backendSessionRef,
        });
        if (result.backendSessionRef) {
          await db
            .update(tasks)
            .set({ backendSessionRef: result.backendSessionRef, updatedAt: new Date() })
            .where(eq(tasks.id, task.id));
        }
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'verify:send_turn_failed',
        );
      }
    }
    await retry(task, newCostTokens, headSha, verdict.missing ?? '', { pullNumber, sha: headSha });
    return 'retried';
  }

  await escalate(task, newCostTokens, verdict.missing ?? 'self-verification failed', {
    pullNumber,
    sha: headSha,
    retriesExhausted: true,
  });
  return 'escalated';
}

async function pass(
  task: Task,
  newCostTokens: number,
  headSha: string,
  aiReviewEnabled: boolean,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({
      status: afterVerifyStatus(aiReviewEnabled),
      costTokens: newCostTokens,
      lastVerifiedSha: headSha,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'verify.passed',
    payload,
    createdAt: now,
  });
}

async function retry(
  task: Task,
  newCostTokens: number,
  headSha: string,
  missing: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  // Back to awaiting_ci: the agent's new push re-triggers CI, which re-routes a
  // green build back through awaiting_verify for re-checking.
  await db
    .update(tasks)
    .set({
      status: 'awaiting_ci',
      costTokens: newCostTokens,
      verifyRetryCount: task.verifyRetryCount + 1,
      lastVerifiedSha: headSha,
      lastError: missing,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'verify.retry_dispatched',
    payload: {
      ...payload,
      verifyRetryCount: task.verifyRetryCount + 1,
      maxRetries: env.VERIFY_RETRY_MAX,
    },
    createdAt: now,
  });
}

async function escalate(
  task: Task,
  newCostTokens: number,
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  // Escalation hands off to a human (awaiting_review) — never silently fail
  // possibly-good work, and a verify *escalation* specifically means "a human
  // should look", so we route to awaiting_review regardless of the AI-review flag.
  await db
    .update(tasks)
    .set({
      status: 'awaiting_review',
      costTokens: newCostTokens,
      lastError: reason,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'verify.escalated',
    payload,
    createdAt: now,
  });
}
