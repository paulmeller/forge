'use server';

import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { ledgerEvents, tasks, type TaskStatus } from '@forge/db';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { buildCreateIssuePayload } from '@/lib/github-issue-create';
import { resolveMissionDefaults } from '@/lib/mission-defaults-db';
import { buildTriageTaskRows, type TriageIssue } from '@/lib/triage-planner';
import { withAuth } from '@/lib/with-auth';
import { getOrCreateIssueMission } from '@/lib/workspace-mission';

/**
 * Enqueue a gated reproduce→fix Task pair for one issue, in the repo's
 * standing triage Mission (created on first use). Dispatches on the next
 * tick — this action only inserts rows.
 */
export async function workOnIssue(
  repo: string,
  issue: { number: number; title: string; body: string; url: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();

  const issueRef = `${repo}#${issue.number}`;

  let mission;
  try {
    const defaults = await resolveMissionDefaults(user.id);
    mission = await getOrCreateIssueMission(user.id, repo, issueRef, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare mission' };
  }

  const triageIssue: TriageIssue = {
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
  };

  const now = new Date();
  const rows = buildTriageTaskRows(mission.id, [triageIssue], now);

  await db.transaction(async (tx) => {
    await tx.insert(tasks).values(rows);
    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'workspace.issue.enqueued',
      payload: { issueRef, taskIds: rows.map((r) => r.id) },
      createdAt: now,
    });
  });

  return { ok: true };
}

/**
 * Files a new issue directly on GitHub. Does not touch Forge's database and
 * does not start any work — the issue shows up via the normal search-based
 * fetch on next page load, exactly like any issue filed on GitHub directly.
 */
export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string; labels?: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  const payload = buildCreateIssuePayload(input);
  if (!payload.title) {
    return { ok: false, error: 'Title is required' };
  }

  const token = env.GITHUB_APP_TOKEN;
  if (!token) {
    return { ok: false, error: 'GITHUB_APP_TOKEN not configured on the server' };
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      ok: false,
      error: `GitHub rejected the issue (${res.status}): ${detail.slice(0, 200)}`,
    };
  }

  return { ok: true };
}

async function cancelManagedAgentsSession(sessionId: string): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.interrupt' }],
  } as never);
}

// Terminal Task statuses (mirrors apps/tick/src/reconciler.ts's
// MISSION_TERMINAL_TASK_STATUSES, minus 'awaiting_review' which is
// mission-terminal but not Task-terminal — no cross-app import needed for
// this small a check).
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['merged', 'resolved', 'abandoned', 'failed'];

/**
 * Abort a running Task's session. Only meaningful for a Task with an active
 * session (running/dispatching/etc.) — marks it failed with haltReason
 * 'manual_abort', mirroring the shape budgets.ts's hardStop already uses for
 * the same kind of forced stop.
 */
export async function abortTask(
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { ok: false, error: 'Task not found' };
  if (!task.sessionId) return { ok: false, error: 'Task has no active session to abort' };
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, error: 'Task has already finished, nothing to abort' };
  }

  try {
    await cancelManagedAgentsSession(task.sessionId);
  } catch (err) {
    return {
      ok: false,
      error: `Could not cancel session: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: 'failed',
        haltReason: 'manual_abort',
        lastError: 'Aborted by operator',
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(tasks.id, taskId));

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.aborted',
      payload: { sessionId: task.sessionId },
      createdAt: now,
    });
  });

  return { ok: true };
}
