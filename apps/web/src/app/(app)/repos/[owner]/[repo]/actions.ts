'use server';

import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { ledgerEvents, missions, tasks, type TaskStatus } from '@forge/db';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { buildCreateIssuePayload } from '@/lib/github-issue-create';
import { resolveMissionDefaults } from '@/lib/mission-defaults-db';
import { pauseMission, resumeMission } from '@/lib/mission-transitions';
import { updateNextIssueRefs } from '@/lib/next-marker';
import { buildTriageTaskRows, type TriageIssue } from '@/lib/triage-planner';
import { withAuth } from '@/lib/with-auth';
import {
  findWorkspaceMission,
  getOrCreateIssueMission,
  getOrCreateWorkspaceMission,
} from '@/lib/workspace-mission';

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
  let defaults;
  try {
    defaults = await resolveMissionDefaults(user.id);
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

  // Working an issue consumes its "Next" mark, if any.
  try {
    const container = await getOrCreateWorkspaceMission(user.id, repo, defaults);
    if (container.nextIssueRefs?.includes(issueRef)) {
      const next = updateNextIssueRefs(container.nextIssueRefs, issueRef, false);
      await db.update(missions).set({ nextIssueRefs: next, updatedAt: new Date() }).where(eq(missions.id, container.id));
    }
  } catch {
    // Non-fatal — the issue was successfully worked either way; a stale
    // Next mark is cosmetic and will be cleared next time this runs.
  }

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

async function sendSteeringMessage(sessionId: string, text: string): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text }],
      },
    ],
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
  const user = await withAuth();

  const [row] = await db
    .select({ task: tasks, ownerId: missions.userId })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row || row.ownerId !== user.id) return { ok: false, error: 'Task not found' };
  const task = row.task;
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

/**
 * Send a mid-run instruction into a Task's live session. The message is
 * appended to the session's event stream (same `user.message` shape the
 * dispatcher uses for the opening turn) and recorded in the audit ledger.
 */
export async function steerTask(
  taskId: string,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();

  const text = message.trim();
  if (!text) return { ok: false, error: 'Message is empty' };

  const [row] = await db
    .select({ task: tasks, ownerId: missions.userId })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row || row.ownerId !== user.id) return { ok: false, error: 'Task not found' };
  const task = row.task;
  if (!task.sessionId) return { ok: false, error: 'Task has no active session to steer' };
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, error: 'Task has already finished, nothing to steer' };
  }

  try {
    await sendSteeringMessage(task.sessionId, text);
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach session: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'task.steered',
    payload: { sessionId: task.sessionId, message: text },
    createdAt: new Date(),
  });

  return { ok: true };
}

/** Pause the repo's container mission — the dispatcher will stop claiming any of its issue leaves' tasks (Task 3 of this plan). */
export async function deactivateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const container = await findWorkspaceMission(user.id, repo);
  if (!container) return { ok: false, error: 'No activity yet for this repo' };
  try {
    await pauseMission(container.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not deactivate' };
  }
}

/** Resume the repo's container mission. */
export async function activateRepo(repo: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const container = await findWorkspaceMission(user.id, repo);
  if (!container) return { ok: false, error: 'No activity yet for this repo' };
  try {
    await resumeMission(container.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not activate' };
  }
}

/** Trigger a tick right now instead of waiting for the next scheduled one. */
export async function triggerManualTick(): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();
  try {
    const pino = (await import('pino')).default;
    const { runTick } = await import('@/server/tick/tick');
    await runTick(pino({ level: env.LOG_LEVEL }));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Tick failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/** Mark or unmark an issue as "Next" on this repo — queued for work without dispatching. */
export async function toggleNextMarker(
  repo: string,
  issueRef: string,
  marked: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  const defaults = await resolveMissionDefaults(user.id);

  let container;
  try {
    container = await getOrCreateWorkspaceMission(user.id, repo, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare container' };
  }

  const next = updateNextIssueRefs(container.nextIssueRefs, issueRef, marked);
  await db.update(missions).set({ nextIssueRefs: next, updatedAt: new Date() }).where(eq(missions.id, container.id));

  return { ok: true };
}
