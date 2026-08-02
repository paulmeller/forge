import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, notInArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { ledgerEvents, tasks, type ReviewDecision, type TaskStatus } from '@forge/db';

import { db } from '@/lib/db';
import { dispatchFromGithub, parseForgeDirective } from '@/lib/dispatch-from-github';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
// GitHub's own idempotency key — a GUID unique per delivery *attempt*
// (retries and redeliveries of the same event get their own value, but a
// raw redelivery of an already-processed one repeats it). See #41 and the
// `deliveryId` doc comment on `GithubDispatchInput`.
const DELIVERY_HEADER = 'x-github-delivery';

type IssueCommentPayload = {
  action?: string;
  comment?: { body?: string; author_association?: string };
  issue?: { number?: number; pull_request?: unknown };
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  sender?: { login?: string };
  // GitHub includes this on every GitHub-App-delivered webhook — the numeric
  // id of the installation that delivered the event. See the doc comment on
  // `GithubDispatchInput.installationId` (dispatch-from-github.ts) for why
  // this is what repo-policy resolution is scoped against (C2).
  installation?: { id?: number };
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
  installation?: { id?: number };
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
  const deliveryId = request.headers.get(DELIVERY_HEADER);

  if (event === 'issue_comment') {
    return handleIssueComment(rawBody, deliveryId);
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

/**
 * GitHub associations trusted to command an agent holding push credentials.
 * NONE / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR are rejected deliberately:
 * having had a PR merged does not confer the right to spend the operator's
 * tokens or drive an agent under their credentials.
 */
const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

async function handleIssueComment(rawBody: string, deliveryId: string | null) {
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

  // Only accounts with real authority over the repo may command an agent that
  // holds push credentials. author_association is GitHub's own assessment of
  // the COMMENT author (not the issue author), present on every
  // issue_comment payload. Without this gate, any account on a public repo
  // could comment `@forge ...` and dispatch an agent under the operator's
  // credentials — prompt injection as a service the moment the repo gets
  // attention. NONE/CONTRIBUTOR/FIRST_TIME* are rejected: having had a PR
  // merged does not confer the right to spend the operator's tokens.
  const association = payload.comment?.author_association;
  if (!association || !ALLOWED_ASSOCIATIONS.has(association)) {
    return NextResponse.json(
      { ignored: true, reason: `author_association ${association ?? 'absent'} not permitted` },
      { status: 200 },
    );
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
    installationId: payload.installation?.id,
    deliveryId: deliveryId ?? undefined,
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
    installationId: payload.installation?.id,
    // I4: this dispatch is Forge reacting to its own PR's CI going red, not
    // a human asking for new work — the plan-approval gate's scope (per the
    // spec) is `@forge` comments. Gating this too would silently turn every
    // CI failure into a draft mission that never runs and a repeated
    // "approve this" comment on the PR. See the doc comment on
    // `bypassPlanApprovalGate` (dispatch-from-github.ts) for the full
    // reasoning and the guardrail against widening this exemption.
    bypassPlanApprovalGate: true,
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
 *
 * EXCEPTION: `needs_human` in `handlePullRequest` specifically, when the PR
 * merged. `needs_human` is not "closed" the way the other four members of
 * this set are — it is the review queue Approve/Dismiss exist to drain, and
 * the most common way a human actually clears it is by merging the PR
 * directly on GitHub rather than clicking Approve in Forge first. Treating
 * a merge as "already settled, ignore" on a `needs_human` row would leave
 * Forge showing merged work as still needing a human forever, with Dismiss
 * (which records it `abandoned`) as the only exit — see the carve-out below
 * where `handlePullRequest` reads this set. `handlePullRequestReview` has no
 * such carve-out: a review event landing on an escalated Task is genuinely
 * stale there, since nothing about a review submission settles the escalation.
 */
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'merged',
  'resolved',
  'needs_human',
  'abandoned',
  'failed',
]);

// A Task in any of these statuses has no PR yet by construction (`prUrl` is
// only ever set alongside the transition into `awaiting_ci`, see state.ts
// and reconciler.ts's tryOpenPr) — so it cannot be the Task a real
// pull_request(_review) event is about. `retryMission` (mission-transitions.ts)
// now clears `prUrl` on every retry specifically so a re-queued Task's row
// no longer matches its previous PR's URL at all; this exclusion is
// defence in depth on top of that fix, not a substitute for it — it guards
// against any other path that might someday leave a stale prUrl on an
// early-stage Task, not just the retry path already closed.
const PRE_PR_TASK_STATUSES: TaskStatus[] = ['queued', 'dispatching', 'running', 'turn_ended'];

/**
 * Tasks are keyed by the PR URL Forge recorded when it opened the PR.
 *
 * `pr_url` has an index (tasks_pr_url_idx) but deliberately no unique
 * constraint — a retried task legitimately reopening against the same PR
 * must not fail an insert. That means this lookup can match more than one
 * row. Order by createdAt descending so a collision deterministically
 * resolves to the most recently created task (the retry, not the stale
 * original) rather than whichever row SQLite happens to return first, and
 * fetch two rows so a collision is observable instead of silently
 * mutating an arbitrary one.
 */
async function taskByPrUrl(prUrl: string) {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.prUrl, prUrl), notInArray(tasks.status, PRE_PR_TASK_STATUSES)))
    .orderBy(desc(tasks.createdAt))
    .limit(2);

  if (rows.length > 1) {
    console.warn(
      `taskByPrUrl: multiple tasks share prUrl=${prUrl} (ids: ${rows
        .map((r) => r.id)
        .join(', ')}); using most recently created`,
    );
  }

  return rows[0] ?? null;
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

  // I3: a merged PR settles a `needs_human` Task same as any other — see the
  // EXCEPTION note on TERMINAL_TASK_STATUSES above. Closed-unmerged from
  // `needs_human` is deliberately NOT carved out here: the Task is already
  // escalated and awaiting a human either way, so leaving it in
  // `needs_human` (falling through to the generic terminal block below) is
  // the correct, defensible outcome rather than a gap.
  const isMergedEscalation = task.status === 'needs_human' && payload.pull_request?.merged === true;
  if (!isMergedEscalation && TERMINAL_TASK_STATUSES.has(task.status)) {
    return NextResponse.json(
      { ok: true, status: task.status, reason: 'already settled' },
      { status: 200 },
    );
  }

  const now = new Date();

  if (payload.pull_request?.merged) {
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'merged',
        updatedAt: now,
        completedAt: now,
        // The fast-path twin of the reconciler merging-sweep's identical
        // clear (reconciler.ts): believed inert today, but every other exit
        // from `merging`/`ready_to_merge` clears approvedBy, and this is the
        // one path an invariant scan wouldn't catch since no existing test
        // drives a row to `merged` through it.
        approvedBy: null,
      })
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
        // The fast-path twin of reconciler.ts's merging-sweep closed-unmerged
        // branch, which observes this exact same fact and clears approvedBy
        // for the exact same reason: the earlier approval was for a PR that
        // just closed unmerged, and does not cover whatever a human decides
        // to do next.
        approvedBy: null,
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
      // Same shape reconciler.ts and auto-merge.ts write for this eventType
      // ({ prNumber, ... }) — not { prUrl } — so a future consumer can read
      // one shape regardless of which of the three writers produced it.
      payload: { prNumber: task.prNumber, reason: 'pr_closed_unmerged' },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, status: 'needs_human' }, { status: 200 });
  }

  const [updated] = await db
    .update(tasks)
    .set({
      status: 'abandoned',
      // This branch handles every non-terminal, non-merging status a Task
      // could be in when its PR closes unmerged — including ready_to_merge,
      // which can carry a human approvedBy (e.g. an approved diff whose PR
      // gets closed on GitHub before auto-merge or the reconciler sweep
      // gets to it). That approval was for a PR that's now dead, so it must
      // not survive onto the abandoned row. (escalationReason is not
      // cleared here: no status this branch can observe — ready_to_merge,
      // queued, or an agent-active status — can carry a non-null one; it is
      // only ever set alongside needs_human, which is filtered out above by
      // TERMINAL_TASK_STATUSES.)
      approvedBy: null,
      updatedAt: now,
      completedAt: now,
    })
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

  let decision: ReviewDecision | null;
  if (payload.action === 'dismissed') {
    // A dismissed review clears the decision — the PR is unreviewed again.
    //
    // KNOWN LIMITATION (see the reviewDecision column comment in
    // packages/db/src/schema.ts): this clears the column even if a
    // *different* reviewer's approval is still standing on GitHub, because
    // the column is a single scalar reflecting only the most recent review
    // event and this handler has no view of the PR's other reviews. Fixing
    // that would need a live GitHub API call or a per-reviewer schema,
    // both out of scope here. Nothing currently gates a merge decision on
    // this field, so don't start relying on it for that.
    decision = null;
  } else {
    const mapped = REVIEW_STATES[payload.review?.state?.toLowerCase() ?? ''];
    if (mapped === undefined) {
      // Unrecognized/unmodeled review.state must not wipe out a previously
      // recorded decision — leave it untouched rather than collapsing to
      // null. Only an explicit `dismissed` action clears it.
      return NextResponse.json(
        { ok: true, decision: task.reviewDecision, reason: 'unrecognized review state' },
        { status: 200 },
      );
    }
    decision = mapped;
  }

  // CAS-guarded like every branch of handlePullRequest: read-then-write
  // otherwise leaves a TOCTOU window against a concurrent settle (e.g. the
  // reconciler sweep or another delivery of this same event).
  const [updated] = await db
    .update(tasks)
    .set({ reviewDecision: decision, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
    .returning();

  if (!updated) {
    return NextResponse.json(
      { ok: true, status: task.status, reason: 'already settled' },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true, decision }, { status: 200 });
}

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
