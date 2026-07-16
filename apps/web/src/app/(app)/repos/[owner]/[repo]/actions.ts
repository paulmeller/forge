'use server';

import { randomUUID } from 'node:crypto';

import { ledgerEvents, tasks } from '@forge/db';

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
