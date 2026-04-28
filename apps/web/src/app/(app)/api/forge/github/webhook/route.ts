import { createHmac, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

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

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
