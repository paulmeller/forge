import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { getAdapter } from './adapters';
import { db } from './db';
import { env } from './env';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type AiReviewResult = {
  tasksChecked: number;
  approved: number;
  rejected: number;
  escalated: number;
  errors: number;
};

export type ReviewDecision = 'approve' | 'reject';

export type ParsedReview = {
  decision: ReviewDecision;
  feedback: string;
};

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

let anthropic: Anthropic | undefined;
function aiClient(): Anthropic {
  if (!anthropic) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

/**
 * Build the review prompt for Claude. Pure function, exported for testing.
 */
export function buildReviewPrompt(opts: {
  goal: string;
  diff: string;
  summary: string;
}): string {
  const diff = opts.diff.slice(0, MAX_DIFF_CHARS);
  const truncated = opts.diff.length > MAX_DIFF_CHARS ? '\n[diff truncated]' : '';

  return `You are a senior engineer performing a code review on a pull request opened by an AI agent.

## Mission Goal

${opts.goal}

## PR Summary

${opts.summary || '(no summary provided)'}

## PR Diff

\`\`\`diff
${diff}${truncated}
\`\`\`

## Review Criteria

Evaluate the diff against the mission goal using these criteria:
1. **Achieves the goal** — the change actually accomplishes what was asked
2. **No bugs or security issues** — no obvious regressions, vulnerabilities, or broken logic
3. **No scope creep** — the change is focused; it doesn't include unrelated modifications
4. **Pragmatic on style** — don't reject for minor style nits; only flag real problems

## Instructions

Respond with a JSON object (no markdown, no code fences) in exactly this format:
{"decision":"approve","feedback":"<reason>"}
or
{"decision":"reject","feedback":"<specific actionable feedback for the agent>"}

Use "approve" if the PR meets the criteria. Use "reject" if there are real problems that must be fixed before merging.`;
}

/**
 * Parse Claude's JSON response into a structured review result. Pure function, exported for testing.
 */
export function parseReviewResponse(text: string): ParsedReview {
  try {
    // Strip markdown code fences if present
    const cleaned = text.trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (parsed.decision !== 'approve' && parsed.decision !== 'reject') {
      return { decision: 'reject', feedback: `invalid decision field: ${String(parsed.decision ?? '(missing)')}` };
    }
    return {
      decision: parsed.decision as ReviewDecision,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
    };
  } catch {
    return { decision: 'reject', feedback: `unparseable response from AI reviewer: ${text.slice(0, 200)}` };
  }
}

/**
 * Tick subsystem: review all tasks in `awaiting_ai_review` state.
 */
export async function runAiReview(log: Logger): Promise<AiReviewResult> {
  const awaiting = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'awaiting_ai_review'), isNotNull(tasks.prUrl)));

  let approved = 0;
  let rejected = 0;
  let escalated = 0;
  let errors = 0;

  for (const task of awaiting) {
    try {
      const outcome = await reviewOne(task, log);
      if (outcome === 'approved') approved += 1;
      else if (outcome === 'rejected') rejected += 1;
      else if (outcome === 'escalated') escalated += 1;
    } catch (err) {
      errors += 1;
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'ai-review:check_failed',
      );
    }
  }

  return {
    tasksChecked: awaiting.length,
    approved,
    rejected,
    escalated,
    errors,
  };
}

type ReviewOutcome = 'approved' | 'rejected' | 'escalated';

async function reviewOne(task: Task, log: Logger): Promise<ReviewOutcome> {
  if (!task.prUrl) return 'escalated';

  const m = PR_URL_RE.exec(task.prUrl);
  if (!m) return 'escalated';
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return 'escalated';
  const pullNumber = Number(pullStr);

  // 1. Fetch PR diff
  const gh = ghClient();
  const diffResponse = await gh.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  });
  // Octokit returns the diff as a string in the response data when format is 'diff'
  const diff = String(diffResponse.data);

  // 2. Look up the mission goal
  const [mission] = await db
    .select({ goal: missions.goal, backend: missions.backend })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  if (!mission) throw new Error(`mission ${task.missionId} not found`);

  // 3. Call Claude directly
  const prompt = buildReviewPrompt({ goal: mission.goal, diff, summary: '' });
  const ai = aiClient();
  const message = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  // 4. Parse the response
  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  const review = parseReviewResponse(rawText);

  // 5. Track token costs
  const tokensUsed = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);
  const newCostTokens = task.costTokens + tokensUsed;

  log.info(
    { taskId: task.id, decision: review.decision, tokens: tokensUsed },
    'ai-review:decision',
  );

  if (review.decision === 'approve') {
    // 6a. Approve: transition to awaiting_review
    await approveTask(task, newCostTokens, { pullNumber, feedback: review.feedback });
    return 'approved';
  }

  // Reject path
  if (task.aiReviewRetryCount < 3) {
    // 6g. Send feedback to agent and retry
    if (task.sessionId) {
      try {
        const adapter = getAdapter(mission.backend);
        await adapter.sendTurn(task.sessionId, review.feedback);
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'ai-review:send_turn_failed',
        );
      }
    }
    await rejectAndRetryTask(task, newCostTokens, review.feedback, {
      pullNumber,
      retryCount: task.aiReviewRetryCount + 1,
    });
    return 'rejected';
  }

  // 6h. Retries exhausted — escalate to human
  await escalateTask(task, newCostTokens, review.feedback, { pullNumber });
  return 'escalated';
}

async function approveTask(
  task: Task,
  newCostTokens: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: 'awaiting_review', costTokens: newCostTokens, updatedAt: now })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ai_review.approved',
    payload,
    createdAt: now,
  });
}

async function rejectAndRetryTask(
  task: Task,
  newCostTokens: number,
  feedback: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({
      status: 'awaiting_ci',
      costTokens: newCostTokens,
      aiReviewRetryCount: task.aiReviewRetryCount + 1,
      lastError: feedback,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ai_review.rejected',
    payload,
    createdAt: now,
  });
}

async function escalateTask(
  task: Task,
  newCostTokens: number,
  feedback: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({
      status: 'awaiting_review',
      costTokens: newCostTokens,
      lastError: feedback,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'ai_review.escalated',
    payload,
    createdAt: now,
  });
}
