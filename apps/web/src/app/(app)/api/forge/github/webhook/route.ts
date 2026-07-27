import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { ledgerEvents, tasks, type TaskStatus } from '@forge/db';

import { db } from '@/lib/db';
import { dispatchFromGithub, parseForgeDirective } from '@/lib/dispatch-from-github';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';

type IssueCommentPayload = {
  action?: string;
  comment?: { body?: string };
  issue?: { number?: number; pull_request?: unknown };
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  sender?: { login?: string };
};

type CheckSuitePayload = {
  action?: string;
  check_suite?: {
    conclusion?: string;
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number; head?: { ref?: string } }>;
    app?: { slug?: string };
  };
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  sender?: { login?: string };
};

export async function POST(request: Request) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'GITHUB_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const sig = request.headers.get(SIGNATURE_HEADER);
  if (!sig || !verifyHmac(secret, rawBody, sig)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const event = request.headers.get(EVENT_HEADER);

  if (event === 'issue_comment') {
    return handleIssueComment(rawBody);
  }

  if (event === 'check_suite') {
    return handleCheckSuite(rawBody);
  }

  if (event === 'pull_request') {
    return handlePullRequest(rawBody);
  }

  if (event === 'pull_request_review') {
    return handlePullRequestReview(rawBody);
  }

  return NextResponse.json({ ignored: true, event }, { status: 200 });
}

// ── @forge comment dispatch ──────────────────────────────────────────

async function handleIssueComment(rawBody: string) {
  let payload: IssueCommentPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (payload.action !== 'created') {
    return NextResponse.json({ ignored: true, action: payload.action }, { status: 200 });
  }

  const goal = parseForgeDirective(payload.comment?.body);
  if (!goal) {
    return NextResponse.json({ ignored: true, reason: 'no @forge directive' }, { status: 200 });
  }

  const repo = payload.repository?.full_name;
  const defaultBranch = payload.repository?.default_branch ?? 'main';
  if (!repo) {
    return NextResponse.json({ error: 'missing repository.full_name' }, { status: 400 });
  }

  const issueNumber = payload.issue?.number;
  const result = await dispatchFromGithub({
    repoFullName: repo,
    defaultBranch,
    goal,
    issueRef: issueNumber ? `${repo}#${issueNumber}` : undefined,
    triggeredBy: payload.sender?.login ?? 'unknown',
  });

  return NextResponse.json(
    { missionId: result.mission.id, taskId: result.taskId, missionUrl: `/missions/${result.mission.id}` },
    { status: 201 },
  );
}

// ── Self-healing CI ──────────────────────────────────────────────────

async function handleCheckSuite(rawBody: string) {
  let payload: CheckSuitePayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (payload.action !== 'completed') {
    return NextResponse.json({ ignored: true, action: payload.action }, { status: 200 });
  }

  const suite = payload.check_suite;
  if (!suite || suite.conclusion !== 'failure') {
    return NextResponse.json({ ignored: true, conclusion: suite?.conclusion }, { status: 200 });
  }

  // Only act on PRs, not direct pushes to main
  const pr = suite.pull_requests?.[0];
  if (!pr) {
    return NextResponse.json({ ignored: true, reason: 'no PR associated' }, { status: 200 });
  }

  const repo = payload.repository?.full_name;
  const branch = suite.head_branch ?? pr.head?.ref ?? 'unknown';
  if (!repo) {
    return NextResponse.json({ error: 'missing repository.full_name' }, { status: 400 });
  }

  const goal = `The CI lint check is failing on this repo. Fix the lint errors and push.

1. Run: npx eslint src/
2. Read the errors it reports
3. Edit each file to fix the errors (remove unused variables, fix misspelled variable names, etc.)
4. Run eslint again to confirm it passes
5. Run: git add -A && git commit -m "fix: resolve lint errors" && git push origin HEAD

The PR already exists — just push the fix commit. Do not open a new PR.`;

  const result = await dispatchFromGithub({
    repoFullName: repo,
    defaultBranch: branch,
    goal,
    issueRef: pr.number ? `${repo}#${pr.number}` : undefined,
    triggeredBy: `ci-fix (${payload.sender?.login ?? 'github'})`,
  });

  return NextResponse.json(
    {
      missionId: result.mission.id,
      taskId: result.taskId,
      trigger: 'check_suite.failure',
      branch,
      prNumber: pr.number,
    },
    { status: 201 },
  );
}

// ── Observe PRs Forge opened ─────────────────────────────────────────
//
// This is a fast path, not the mechanism. The Forge GitHub App must have its
// event subscriptions edited in the App settings UI (no API for that) before
// either of these ever fires, and even once subscribed, delivery is
// best-effort. `runReconciler`'s merging sweep (server/tick/reconciler.ts)
// polls GitHub directly every tick and is what actually keeps `merging`
// Tasks from wedging forever — these handlers only shave the latency down
// when they do fire. Both paths guard every update on the status they read
// (`WHERE id = ? AND status = ?`, mirroring the sweep) so whichever of the
// two — webhook or sweep — settles the Task first wins, and the other
// becomes a no-op instead of a corrupting overwrite.

type PullRequestPayload = {
  action?: string;
  pull_request?: { html_url?: string; merged?: boolean };
  review?: { state?: string };
};

/**
 * Statuses a Task cannot leave without a human, or that already reflect a
 * settled outcome (mirrors reconciler.ts's MISSION_TERMINAL_TASK_STATUSES).
 * Once a Task is in one of these, further pull_request(_review) events for
 * its PR are stale — by definition something already closed the loop
 * (this handler on a prior delivery, the reconciler sweep, or a human) —
 * and must not be allowed to touch it again.
 */
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'merged',
  'resolved',
  'needs_human',
  'abandoned',
  'failed',
]);

/** Tasks are keyed by the PR URL Forge recorded when it opened the PR. */
async function taskByPrUrl(prUrl: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.prUrl, prUrl)).limit(1);
  return row ?? null;
}

/**
 * Closing the loop on PRs Forge opened. Without this a human merging on
 * GitHub was never observed, so the Task sat in the review queue forever
 * while its Mission had already auto-completed around it.
 */
async function handlePullRequest(rawBody: string) {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  if (payload.action !== 'closed') {
    return NextResponse.json({ ignored: true, action: payload.action }, { status: 200 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return NextResponse.json({ ignored: true }, { status: 200 });

  const task = await taskByPrUrl(prUrl);
  if (!task) return NextResponse.json({ ignored: true, reason: 'unknown pr' }, { status: 200 });

  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return NextResponse.json(
      { ok: true, status: task.status, reason: 'already settled' },
      { status: 200 },
    );
  }

  const now = new Date();

  if (payload.pull_request?.merged) {
    const [updated] = await db
      .update(tasks)
      .set({ status: 'merged', updatedAt: now, completedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) {
      return NextResponse.json(
        { ok: true, status: task.status, reason: 'already settled' },
        { status: 200 },
      );
    }
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'pr.merged',
      payload: { prUrl },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, status: 'merged' }, { status: 200 });
  }

  // Closed without merging.
  //
  // CONFLICT RESOLUTION (task-3-brief.md Step 4 vs. reconciler.ts's merging
  // sweep): the brief maps every closed-unmerged PR to `abandoned`. But if
  // this Task was in `merging`, GitHub's native auto-merge was armed
  // (auto-merge.ts's tryMerge) and the PR closed anyway — a human closed
  // it, or auto-merge got disarmed. The sweep already treats that exact
  // fact as `needs_human` / `escalationReason: 'auto_merge_failed'`; since
  // this handler and the sweep observe the same GitHub event through two
  // different channels, they must agree, or behaviour becomes a race on
  // which one fires first. Resolution: match the sweep whenever the Task
  // was `merging` — something was armed, so a human needs to look. For
  // every other pre-close status nothing was armed, so there's nothing to
  // escalate; `abandoned` (the brief's answer) is correct there.
  if (task.status === 'merging') {
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'needs_human',
        escalationReason: 'auto_merge_failed',
        lastError:
          'PR closed without merging while auto-merge was armed — a human closed it, or auto-merge was disarmed',
        updatedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'merging')))
      .returning();
    if (!updated) {
      return NextResponse.json(
        { ok: true, status: task.status, reason: 'already settled' },
        { status: 200 },
      );
    }
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'auto_merge.failed',
      payload: { prUrl, reason: 'pr_closed_unmerged' },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, status: 'needs_human' }, { status: 200 });
  }

  const [updated] = await db
    .update(tasks)
    .set({ status: 'abandoned', updatedAt: now, completedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
    .returning();
  if (!updated) {
    return NextResponse.json(
      { ok: true, status: task.status, reason: 'already settled' },
      { status: 200 },
    );
  }
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'pr.closed',
    payload: { prUrl },
    createdAt: now,
  });
  return NextResponse.json({ ok: true, status: 'abandoned' }, { status: 200 });
}

const REVIEW_STATES: Record<string, 'approved' | 'changes_requested' | 'commented'> = {
  approved: 'approved',
  changes_requested: 'changes_requested',
  commented: 'commented',
};

async function handlePullRequestReview(rawBody: string) {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) return NextResponse.json({ ignored: true }, { status: 200 });

  const task = await taskByPrUrl(prUrl);
  if (!task) return NextResponse.json({ ignored: true, reason: 'unknown pr' }, { status: 200 });

  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return NextResponse.json(
      { ok: true, status: task.status, reason: 'already settled' },
      { status: 200 },
    );
  }

  // A dismissed review clears the decision — the PR is unreviewed again.
  const decision =
    payload.action === 'dismissed'
      ? null
      : (REVIEW_STATES[payload.review?.state?.toLowerCase() ?? ''] ?? null);

  await db
    .update(tasks)
    .set({ reviewDecision: decision, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  return NextResponse.json({ ok: true, decision }, { status: 200 });
}

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
