import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type NewTask } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { PlannerError, type PlanResult } from './planner';

/**
 * A GitHub issue the triage Planner turns into a reproduce→fix Task pair.
 * `repo` is `owner/name`, derived from the issue's repository.
 */
export type TriageIssue = {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
};

/** Injectable issue source so the Planner core is testable without GitHub. */
export type TriageDeps = {
  listIssues: (query: string) => Promise<TriageIssue[]>;
};

const SEARCH_PAGE_SIZE = 100;
/** Cap per Mission — mirrors the LLM planner's 20-Task ceiling, applied to issues. */
const MAX_ISSUES = 50;

/**
 * Triage Planner (PRD §6.4 backlog triage). Enumerates issues matching the
 * Mission's `issueQuery` and emits, per issue, a gated pair of Tasks:
 *
 *   reproduce  (kind='reproduce', opens no PR, records a verdict)
 *        │  depends_on
 *        ▼
 *   fix        (kind='fix', runs only once the reproduce verdict says the bug
 *               reproduced — see the dispatcher gate and reconciler)
 *
 * Idempotent like the rule-based planner: draft-only, one `planner.emitted`
 * ledger event, Mission transitions draft → planning.
 */
export async function runTriagePlanner(
  missionId: string,
  deps: TriageDeps = { listIssues: githubSearchIssues },
): Promise<PlanResult> {
  // Fetch issues before opening the transaction — the search is a network call
  // and we don't want it holding a write lock.
  const [pre] = await db
    .select({ status: missions.status, issueQuery: missions.issueQuery })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);

  if (!pre) throw new PlannerError('mission not found', 'MISSION_NOT_FOUND');
  if (pre.status !== 'draft') {
    throw new PlannerError(
      `mission is ${pre.status}; planner only runs on draft`,
      pre.status === 'planning' ? 'ALREADY_PLANNED' : 'WRONG_STATUS',
    );
  }
  const query = pre.issueQuery?.trim();
  if (!query) {
    throw new PlannerError('triage mission has no issue query', 'NO_TARGET_REPOS');
  }

  const issues = (await deps.listIssues(query)).slice(0, MAX_ISSUES);

  return db.transaction(async (tx) => {
    // Re-read inside the tx and re-check the guard to stay race-safe with a
    // concurrent plan call (mirrors runPlanner).
    const [mission] = await tx
      .select()
      .from(missions)
      .where(eq(missions.id, missionId))
      .limit(1);
    if (!mission) throw new PlannerError('mission not found', 'MISSION_NOT_FOUND');
    if (mission.status !== 'draft') {
      throw new PlannerError(
        `mission is ${mission.status}; planner only runs on draft`,
        mission.status === 'planning' ? 'ALREADY_PLANNED' : 'WRONG_STATUS',
      );
    }

    const now = new Date();
    const rows = buildTriageTaskRows(mission.id, issues, now);

    if (rows.length > 0) {
      await tx.insert(tasks).values(rows);
    }

    const [updated] = await tx
      .update(missions)
      .set({ status: 'planning', updatedAt: now })
      .where(eq(missions.id, mission.id))
      .returning();

    await tx.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: mission.id,
      eventType: 'planner.emitted',
      payload: {
        strategy: 'triage',
        taskIds: rows.map((r) => r.id),
        issueCount: issues.length,
        repos: [...new Set(issues.map((i) => i.repo))],
      },
      createdAt: now,
    });

    if (!updated) {
      throw new PlannerError('mission update returned no rows', 'MISSION_NOT_FOUND');
    }

    return { mission: updated, taskCount: rows.length };
  });
}

/**
 * Pure builder: turn a list of issues into ordered `reproduce`, `fix` Task rows
 * where each `fix` depends on its `reproduce`. Extracted from the transaction so
 * the pairing / gating wiring is unit-testable without a database.
 */
export function buildTriageTaskRows(
  missionId: string,
  issues: TriageIssue[],
  now: Date,
): NewTask[] {
  const rows: NewTask[] = [];
  for (const issue of issues) {
    const issueRef = `${issue.repo}#${issue.number}`;
    const promptVars = {
      repo: issue.repo,
      base_branch: 'main',
      issue_number: issue.number,
      issue_title: issue.title,
      issue_body: issue.body,
      issue_url: issue.url,
    };
    const reproduceId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const fixId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

    rows.push({
      id: reproduceId,
      missionId,
      repo: issue.repo,
      baseBranch: 'main',
      kind: 'reproduce',
      issueRef,
      status: 'queued',
      promptVars,
      createdAt: now,
      updatedAt: now,
    });
    rows.push({
      id: fixId,
      missionId,
      repo: issue.repo,
      baseBranch: 'main',
      kind: 'fix',
      issueRef,
      dependsOnIds: [reproduceId],
      status: 'queued',
      promptVars,
      createdAt: now,
      updatedAt: now,
    });
  }
  return rows;
}

export type GithubSearchItem = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
};

/**
 * Default issue source: GitHub's issue-search API. `query` is a raw search
 * qualifier string, e.g. `repo:vercel/ai is:issue is:open label:bug`.
 * Pull requests are filtered out (the search API returns PRs as "issues").
 */
export async function githubSearchIssues(query: string): Promise<TriageIssue[]> {
  const token = env.GITHUB_APP_TOKEN;
  if (!token) {
    throw new PlannerError('GITHUB_APP_TOKEN not configured for triage search', 'NO_TARGET_REPOS');
  }
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', String(SEARCH_PAGE_SIZE));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new PlannerError(
      `github issue search failed (${res.status}): ${detail.slice(0, 200)}`,
      'NO_TARGET_REPOS',
    );
  }
  const json = (await res.json()) as { items?: GithubSearchItem[] };
  return mapSearchItems(json.items ?? []);
}

/**
 * Pure mapping of GitHub search results to `TriageIssue`s. Drops pull requests
 * (the search API returns them as "issues") and any item whose repo can't be
 * parsed.
 */
export function mapSearchItems(items: GithubSearchItem[]): TriageIssue[] {
  return items
    .filter((it) => !it.pull_request)
    .map((it) => ({
      repo: repoFromApiUrl(it.repository_url),
      number: it.number,
      title: it.title,
      body: it.body ?? '',
      url: it.html_url,
    }))
    .filter((i) => i.repo.length > 0);
}

/** `https://api.github.com/repos/vercel/ai` → `vercel/ai`. */
function repoFromApiUrl(repositoryUrl: string): string {
  const marker = '/repos/';
  const idx = repositoryUrl.indexOf(marker);
  return idx === -1 ? '' : repositoryUrl.slice(idx + marker.length);
}
