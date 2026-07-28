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

import { db } from '@/lib/db';
import { getOctokitClient } from '@/lib/octokit';
import { resolveAutoMergePolicy } from './auto-merge-policy';

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

export const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

// Re-exported for existing callers (`import { client as getOctokit } from
// './auto-merge'`); the singleton itself now lives in `@/lib/octokit` so
// `lib/` modules (e.g. GitHub-dispatch's plan-link comment) can share it too
// without importing from `server/tick/`. One singleton, one auth path —
// don't add another `new Octokit(...)` call elsewhere; import that instead.
export function client(): Octokit {
  return getOctokitClient();
}

/**
 * For each Mission with an auto-merge policy, find `ready_to_merge` Tasks
 * whose PR shape matches the policy and hand them to GitHub's native
 * auto-merge.
 *
 * `needs_human` Tasks are structurally excluded: the status split exists so
 * that a Task which failed AI review, failed self-verify, stalled in a gate,
 * or bounced off a previous merge attempt can never be selected here — a
 * small diff is not evidence that rejected work is safe.
 */
export async function runAutoMerge(log: Logger): Promise<AutoMergeResult> {
  const candidates = await db
    .select({
      task: tasks,
      mission: missions,
    })
    .from(tasks)
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(eq(tasks.status, 'ready_to_merge'), isNotNull(tasks.prUrl)));

  // Per-invocation memoization only: several candidates above commonly share
  // one Mission, and resolveAutoMergePolicy is a live DB lookup (up to two
  // queries) — re-resolving the same missionId repeatedly within this one
  // pass would be pure waste. Deliberately NOT a process-wide or cross-tick
  // cache: that would defeat the entire point of the resolver, which is that
  // enabling auto-merge on a repo must free Tasks that already exist on the
  // very next tick, not whenever some longer-lived cache next expires.
  const policyCache = new Map<string, AutoMergePolicy | null>();
  async function resolvePolicyCached(missionId: string): Promise<AutoMergePolicy | null> {
    const cached = policyCache.get(missionId);
    if (cached !== undefined) return cached;
    const policy = await resolveAutoMergePolicy(missionId);
    policyCache.set(missionId, policy);
    return policy;
  }

  let merged = 0;
  let blocked = 0;
  let errors = 0;

  for (const row of candidates) {
    const policy = await resolvePolicyCached(row.mission.id);
    if (!policy?.enabled) continue;
    if (policy.requireHumanApproval && !row.task.approvedBy) continue;

    try {
      const result = await tryMerge(row.task, row.mission, policy, log);
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
  log: Logger,
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

  // I5: re-check the approval against the PR's CURRENT head SHA, not just
  // whether `approvedBy` is set. `runAutoMerge` already filtered out tasks
  // where `policy.requireHumanApproval` is true and `approvedBy` is unset,
  // so reaching here with `requireHumanApproval` true means `approvedBy` is
  // non-null — but that only proves *a* diff was approved once, not that
  // it's *this* diff. A force-push to the PR head after Approve was clicked
  // changes the diff without moving the Task's status, so nothing else
  // would ever catch it. Refuse rather than silently arming a merge on work
  // nobody actually reviewed.
  if (policy.requireHumanApproval) {
    if (!task.approvedHeadSha || task.approvedHeadSha !== pr.head.sha) {
      await markBlocked(task, mission, pullNumber, [
        `approval no longer applies — PR head is ${pr.head.sha}, approved diff was ` +
          `${task.approvedHeadSha ?? 'unknown (no SHA recorded at approval time)'}; re-approve to merge`,
      ]);
      return 'blocked';
    }
  }

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

  // Merge-time gating belongs to GitHub, not to us. Read the branch's
  // required checks; an empty set means nothing would gate the merge, so
  // native auto-merge would fire instantly — block instead of pretending
  // the diff-shape check made that safe.
  const requiredResult = await requiredChecksFor(gh, owner, repo, pr.base.ref);
  if (requiredResult.status === 'unknown') {
    // We couldn't get a real answer (403/500/timeout/etc) — that is NOT the
    // same thing as "branch has no required checks". Don't merge on an
    // unknown; say so explicitly so the operator doesn't get a false "branch
    // is unprotected" diagnosis, and surface it the same way runAutoMerge's
    // outer catch would (warn-level log) since the swallow here would
    // otherwise hide it from that path entirely.
    log.warn(
      { taskId: task.id, err: requiredResult.error },
      'auto-merge:required_checks_unknown',
    );
    await markBlocked(task, mission, pullNumber, [
      `branch '${pr.base.ref}' required-checks status is unknown (${requiredResult.error}) — refusing to auto-merge`,
    ]);
    return 'blocked';
  }
  const required = requiredResult.checks;
  if (required.length === 0) {
    await markBlocked(task, mission, pullNumber, [
      `branch '${pr.base.ref}' has no required checks configured — refusing to auto-merge`,
    ]);
    return 'blocked';
  }

  const missingChecks = (policy.requiredChecks ?? []).filter((c) => !required.includes(c));
  if (missingChecks.length > 0) {
    await markBlocked(task, mission, pullNumber, [
      `policy requires checks the branch does not: ${missingChecks.join(', ')}`,
    ]);
    return 'blocked';
  }

  const now = new Date();
  await db.update(tasks).set({ status: 'merging', updatedAt: now }).where(eq(tasks.id, task.id));

  let mergeError: string | null = null;
  try {
    await gh.graphql(
      `mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { pullRequestId: pr.node_id },
    );
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }

  if (!mergeError) {
    // Armed, not merged. GitHub merges when the required checks pass, on its
    // own schedule — this Task sits in `merging` until then. Nothing pushes
    // it onward from here: the Forge GitHub App isn't subscribed to the
    // `pull_request` webhook event, so a webhook handler for it (even once
    // one exists) can only ever be a fast path, never the only path. The
    // reconciler's merging sweep is what actually reconciles this Task —
    // each tick it asks GitHub for the PR's state directly and moves the
    // Task to `merged` or escalates to `needs_human`.
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'auto_merge.armed',
      payload: {
        prNumber: pullNumber,
        method: 'squash',
        requiredChecks: required,
        additions: pr.additions,
        deletions: pr.deletions,
        filesChanged: pr.changed_files,
      },
      createdAt: new Date(),
    });
    return 'merged';
  }

  // Roll back to needs_human so the operator can intervene. Clear
  // approvedBy: the approval that got this Task here covered a merge attempt
  // that just failed, not whatever comes next — a re-escalation to a human
  // must not carry a stale rubber stamp forward (see requireHumanApproval in
  // runAutoMerge above).
  const errAt = new Date();
  await db
    .update(tasks)
    .set({
      status: 'needs_human',
      escalationReason: 'auto_merge_failed',
      approvedBy: null,
      lastError: `auto-merge failed: ${mergeError ?? 'unknown'}`,
      updatedAt: errAt,
    })
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
  // Don't change task status; just write lastError + a ledger event so the
  // operator sees why. Genuinely idempotent, not merely commented as such:
  // `task` is the row `runAutoMerge` selected fresh at the top of THIS tick,
  // so if the reason set hasn't changed since the last tick that blocked
  // this same Task, `task.lastError` already equals what we're about to
  // write — skip both writes rather than re-appending an identical
  // `auto_merge.blocked` ledger event and re-touching `updatedAt` on every
  // tick for as long as the Task sits blocked. A real change in the reason
  // set (a new/different violation) still writes normally.
  const message = `auto-merge blocked: ${reasons.join('; ')}`;
  if (task.lastError === message) return;

  const now = new Date();
  await db
    .update(tasks)
    .set({
      lastError: message,
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

export type RequiredChecksResult =
  | { status: 'known'; checks: string[] }
  | { status: 'unknown'; error: string };

/**
 * Required status checks on a branch. A 404 means no protection rule
 * exists — that is a normal, known answer ("unprotected"), so it maps to
 * `{ status: 'known', checks: [] }` rather than an error. Any other failure
 * (403, 500, network timeout, ...) means we genuinely don't know whether the
 * branch is protected — that must NOT be reported the same way, because the
 * caller treats an empty check list as "safe to refuse merging on", and a
 * 403 is not evidence of that.
 */
async function requiredChecksFor(
  gh: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<RequiredChecksResult> {
  try {
    const { data } = await gh.repos.getBranchProtection({ owner, repo, branch });
    return { status: 'known', checks: data.required_status_checks?.contexts ?? [] };
  } catch (err) {
    const status = (err as { status?: number } | null | undefined)?.status;
    if (status === 404) return { status: 'known', checks: [] };
    return { status: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}
