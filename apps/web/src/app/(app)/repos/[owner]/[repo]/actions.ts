'use server';

import { randomUUID } from 'node:crypto';

import { ledgerEvents, missions, tasks } from '@forge/db';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { buildCreateIssuePayload } from '@/lib/github-issue-create';
import { resolveMissionDefaults, userCanAccessRepo } from '@/lib/mission-defaults-db';
import { pauseMission, resumeMission } from '@/lib/mission-transitions';
import { updateNextIssueRefs } from '@/lib/next-marker';
import { abortTaskForUser, steerTaskForUser, type TaskOpResult } from '@/lib/task-session-ops';
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

  // repo is caller-supplied — a bare Server Action POST reachable without
  // rendering any page. Without this check, any authenticated user could
  // name a repo they have no GitHub App installation for and still mint a
  // Mission they own whose workspaceRepo names it: a structurally genuine
  // container that would pass every downstream ownership check (see
  // userCanAccessRepo's doc comment, mission-defaults-db.ts). "Not yours"
  // and "does not exist" must look identical here, so the error is the
  // same generic fallback the catch below already returns for other
  // mission-prep failures — it must not leak which case this is.
  if (!(await userCanAccessRepo(user.id, repo))) {
    return { ok: false, error: 'Could not prepare mission' };
  }

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

/**
 * Abort a running Task's session. Thin transport over `abortTaskForUser`
 * (lib/task-session-ops.ts) — shared with the `/api/v1` abort route so the
 * auth-ownership behaviour cannot drift between the two transports. This
 * wrapper only resolves the caller via withAuth(); everything else (the
 * ownership-scoped lookup, the terminal-status guard, the adapter call, the
 * transactional write) lives in the shared function.
 */
export async function abortTask(taskId: string): Promise<TaskOpResult> {
  const user = await withAuth();
  return abortTaskForUser(taskId, user.id);
}

/**
 * Send a mid-run instruction into a Task's live session. Thin transport over
 * `steerTaskForUser` (lib/task-session-ops.ts) — shared with the `/api/v1`
 * steer route, same rationale as `abortTask` above.
 */
export async function steerTask(taskId: string, message: string): Promise<TaskOpResult> {
  const user = await withAuth();
  return steerTaskForUser(taskId, user.id, message);
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

  // See the identical guard (and its rationale) in workOnIssue above — repo
  // is caller-supplied here too, and getOrCreateWorkspaceMission below would
  // otherwise mint a genuine, ownership-passing container for a repo this
  // user never had any installation covering.
  if (!(await userCanAccessRepo(user.id, repo))) {
    return { ok: false, error: 'Could not prepare container' };
  }

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
