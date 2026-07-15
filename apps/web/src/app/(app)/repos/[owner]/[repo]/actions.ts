'use server';

import { randomUUID } from 'node:crypto';

import { ledgerEvents, tasks } from '@forge/db';

import { db } from '@/lib/db';
import { resolveMissionDefaults } from '@/lib/mission-defaults-db';
import { buildTriageTaskRows, type TriageIssue } from '@/lib/triage-planner';
import { withAuth } from '@/lib/with-auth';
import { getOrCreateWorkspaceMission } from '@/lib/workspace-mission';

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

  let mission;
  try {
    const defaults = await resolveMissionDefaults(user.id);
    mission = await getOrCreateWorkspaceMission(user.id, repo, defaults);
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

  await db.insert(tasks).values(rows);
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'workspace.issue.enqueued',
    payload: { issueRef: `${repo}#${issue.number}`, taskIds: rows.map((r) => r.id) },
    createdAt: now,
  });

  return { ok: true };
}
