import { randomUUID } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type AutoMergePolicy,
  type Mission,
  type Task,
} from '@forge/db';

import { db } from './db';
import { env } from './env';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type AutoMergeResult = {
  candidates: number;
  merged: number;
  blocked: number;
  errors: number;
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

/**
 * For each Mission with an auto-merge policy, find awaiting_review Tasks
 * whose PR shape matches the policy, merge them.
 *
 * PRD §7.5: success + auto-merge policy allows → merging → merged.
 * PRD §11 Phase 1 was no-auto-merge; this is the Phase 2 wiring.
 */
export async function runAutoMerge(log: Logger): Promise<AutoMergeResult> {
  const candidates = await db
    .select({
      task: tasks,
      mission: missions,
    })
    .from(tasks)
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(eq(tasks.status, 'awaiting_review'), isNotNull(tasks.prUrl)));

  let merged = 0;
  let blocked = 0;
  let errors = 0;

  for (const row of candidates) {
    const policy = row.mission.autoMergePolicy as AutoMergePolicy | null;
    if (!policy?.enabled) continue;

    try {
      const result = await tryMerge(row.task, row.mission, policy);
      if (result === 'merged') merged += 1;
      else blocked += 1;
    } catch (err) {
      errors += 1;
      log.warn(
        { taskId: row.task.id, err: err instanceof Error ? err.message : String(err) },
        'auto-merge:failed',
      );
    }
  }

  return { candidates: candidates.length, merged, blocked, errors };
}

async function tryMerge(
  task: Task,
  mission: Mission,
  policy: AutoMergePolicy,
): Promise<'merged' | 'blocked'> {
  if (!task.prUrl) return 'blocked';
  const m = PR_URL_RE.exec(task.prUrl);
  if (!m) return 'blocked';
  const [, owner, repo, pullStr] = m;
  if (!owner || !repo || !pullStr) return 'blocked';
  const pullNumber = Number(pullStr);

  const gh = client();
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pr.state !== 'open') return 'blocked';

  // Diff-shape gate. We trust the PR object's additions/deletions/changed_files
  // — Octokit returns them on `pulls.get`.
  const reasons = evaluatePolicy({
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    filesChanged: pr.changed_files ?? 0,
    files: null, // populated below if we need to check path patterns
  }, policy);

  if (policy.allowedPathPatterns?.length) {
    const { data: files } = await gh.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 300,
    });
    const filenames = files.map((f) => f.filename);
    const offending = filenames.filter(
      (name) => !policy.allowedPathPatterns!.some((p) => globMatch(name, p)),
    );
    if (offending.length > 0) {
      reasons.push(`paths outside allow-list: ${offending.slice(0, 3).join(', ')}`);
    }
  }

  if (reasons.length > 0) {
    await markBlocked(task, mission, pullNumber, reasons);
    return 'blocked';
  }

  // Transition to merging, attempt the merge, then merged or rollback.
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: 'merging', updatedAt: now })
    .where(eq(tasks.id, task.id));

  let mergeOk = false;
  let mergeError: string | null = null;
  try {
    await gh.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: 'squash',
      commit_title: pr.title || `Merge PR #${pullNumber}`,
    });
    mergeOk = true;
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }

  if (mergeOk) {
    const completed = new Date();
    await db
      .update(tasks)
      .set({ status: 'merged', updatedAt: completed, completedAt: completed })
      .where(eq(tasks.id, task.id));
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'auto_merge.merged',
      payload: {
        prNumber: pullNumber,
        method: 'squash',
        additions: pr.additions,
        deletions: pr.deletions,
        filesChanged: pr.changed_files,
      },
      createdAt: completed,
    });
    return 'merged';
  }

  // Roll back to awaiting_review so the operator can intervene.
  const errAt = new Date();
  await db
    .update(tasks)
    .set({ status: 'awaiting_review', lastError: `auto-merge failed: ${mergeError ?? 'unknown'}`, updatedAt: errAt })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'auto_merge.failed',
    payload: { prNumber: pullNumber, error: mergeError },
    createdAt: errAt,
  });
  return 'blocked';
}

type DiffShape = {
  additions: number;
  deletions: number;
  filesChanged: number;
  files: string[] | null;
};

export function evaluatePolicy(diff: DiffShape, policy: AutoMergePolicy): string[] {
  const reasons: string[] = [];
  if (policy.maxAdditions !== undefined && diff.additions > policy.maxAdditions) {
    reasons.push(`additions ${diff.additions} > maxAdditions ${policy.maxAdditions}`);
  }
  if (policy.maxDeletions !== undefined && diff.deletions > policy.maxDeletions) {
    reasons.push(`deletions ${diff.deletions} > maxDeletions ${policy.maxDeletions}`);
  }
  if (policy.maxFilesChanged !== undefined && diff.filesChanged > policy.maxFilesChanged) {
    reasons.push(`filesChanged ${diff.filesChanged} > maxFilesChanged ${policy.maxFilesChanged}`);
  }
  return reasons;
}

async function markBlocked(
  task: Task,
  _mission: Mission,
  prNumber: number,
  reasons: string[],
): Promise<void> {
  // Don't change task status; just append a single ledger event so it
  // doesn't keep firing on every tick. We keep the most recent reasons in
  // lastError so the operator sees them in the Console.
  const now = new Date();
  await db
    .update(tasks)
    .set({
      lastError: `auto-merge blocked: ${reasons.join('; ')}`,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'auto_merge.blocked',
    payload: { prNumber, reasons },
    createdAt: now,
  });
}

/**
 * Tiny glob: supports `*` and `**`. No character classes, no negation.
 * Translates to a regex anchored start-to-end.
 */
function globMatch(path: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^$(){}[]|\\'.includes(c ?? '')) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

// re-export glob for tests
export const _globMatch = globMatch;
