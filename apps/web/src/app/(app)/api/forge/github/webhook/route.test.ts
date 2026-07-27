import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Real libSQL file + migrations, same pattern as reconciler-merge.test.ts and
// the missions/[id]/cancel route test — exercises the actual drizzle guards
// (`WHERE id = ? AND status = ?`) rather than a mocked db.
const DB_FILE = `/tmp/forge-webhook-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const WEBHOOK_SECRET = 'test-webhook-secret';
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let POST: typeof import('./route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ POST } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function postSigned(event: string, payload: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return POST(
    new Request('http://x/api/forge/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-hub-signature-256': sign(secret, body) },
      body,
    }),
  );
}

// Every seeded task gets its own PR URL (a fresh pull number) so tasks from
// different tests sharing one DB file never collide on `taskByPrUrl`'s
// `WHERE pr_url = ?` lookup.
let prCounter = 0;
function freshPrUrl(): string {
  prCounter += 1;
  return `https://github.com/acme/api/pull/${prCounter}`;
}

async function seedTask(over: {
  id: string;
  status: string;
  escalationReason?: string | null;
}): Promise<string> {
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const prUrl = freshPrUrl();
  await db.insert(schema.missions).values({
    id: missionId,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.tasks).values({
    id: over.id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: over.status as never,
    prUrl,
    prNumber: prCounter,
    escalationReason: (over.escalationReason ?? null) as never,
    createdAt: now,
    updatedAt: now,
  });
  return prUrl;
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await getTask(id))?.status;
}

async function reviewDecisionOf(id: string): Promise<string | null | undefined> {
  return (await getTask(id))?.reviewDecision;
}

async function getLedgerEvents(taskId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.taskId, taskId));
}

describe('POST /api/forge/github/webhook — signature verification', () => {
  it('rejects an unsigned request with 401 before routing to any handler', async () => {
    const res = await POST(
      new Request('http://x/api/forge/github/webhook', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request' },
        body: JSON.stringify({ action: 'closed' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const res = await postSigned(
      'pull_request',
      { action: 'closed', pull_request: { html_url: 'https://github.com/acme/api/pull/1', merged: true } },
      'wrong-secret',
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/forge/github/webhook — pull_request', () => {
  it('marks the task merged when a human merges the PR on GitHub', async () => {
    const prUrl = await seedTask({ id: 'tsk_1', status: 'ready_to_merge' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: true },
    });
    expect(res.status).toBe(200);
    expect(await statusOf('tsk_1')).toBe('merged');

    const events = await getLedgerEvents('tsk_1');
    expect(events.find((e) => e.eventType === 'pr.merged')).toBeDefined();
  });

  it('abandons the task when the PR is closed unmerged and nothing was armed', async () => {
    const prUrl = await seedTask({ id: 'tsk_2', status: 'ready_to_merge' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);
    expect(await statusOf('tsk_2')).toBe('abandoned');

    const events = await getLedgerEvents('tsk_2');
    expect(events.find((e) => e.eventType === 'pr.closed')).toBeDefined();
  });

  // Conflict resolution with reconciler.ts's merging sweep: a Task that was
  // `merging` (GitHub native auto-merge armed) whose PR closes unmerged must
  // escalate to needs_human/auto_merge_failed exactly like the sweep does —
  // NOT plain `abandoned` — so the two paths never disagree about the same
  // GitHub fact depending on which one happens to observe it first.
  it('escalates to needs_human/auto_merge_failed — not abandoned — when a merging task closes unmerged', async () => {
    const prUrl = await seedTask({ id: 'tsk_merging_closed', status: 'merging' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);

    const task = await getTask('tsk_merging_closed');
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('auto_merge_failed');
    expect(task?.lastError).toMatch(/closed without merging/);

    const events = await getLedgerEvents('tsk_merging_closed');
    expect(events.find((e) => e.eventType === 'auto_merge.failed')).toBeDefined();
  });

  it('still marks a merging task merged when GitHub reports the PR merged', async () => {
    const prUrl = await seedTask({ id: 'tsk_merging_merged', status: 'merging' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: true },
    });
    expect(res.status).toBe(200);
    expect(await statusOf('tsk_merging_merged')).toBe('merged');
  });

  it('ignores events for PRs Forge did not open', async () => {
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: 'https://github.com/x/y/pull/999999', merged: true },
    });
    expect(res.status).toBe(200);
  });

  it('ignores non-closed actions without touching the task', async () => {
    const prUrl = await seedTask({ id: 'tsk_opened', status: 'ready_to_merge' });
    const res = await postSigned('pull_request', {
      action: 'opened',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);
    expect(await statusOf('tsk_opened')).toBe('ready_to_merge');
  });

  it('is idempotent: a webhook arriving after the task already merged does not corrupt it', async () => {
    const prUrl = await seedTask({ id: 'tsk_already_merged', status: 'merged' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: true },
    });
    expect(res.status).toBe(200);
    expect(await statusOf('tsk_already_merged')).toBe('merged');
    // No duplicate ledger event from a stale/replayed delivery.
    const events = await getLedgerEvents('tsk_already_merged');
    expect(events.filter((e) => e.eventType === 'pr.merged')).toHaveLength(0);
  });

  it('is idempotent: a webhook arriving after the sweep already escalated the task does not overwrite it', async () => {
    // Simulates the sweep (reconciler.ts) having already settled this Task
    // to needs_human before the webhook's (possibly delayed) delivery
    // arrives for the same PR-closed-unmerged fact.
    const prUrl = await seedTask({
      id: 'tsk_already_escalated',
      status: 'needs_human',
      escalationReason: 'auto_merge_failed',
    });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);
    const task = await getTask('tsk_already_escalated');
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('auto_merge_failed');
  });
});

describe('POST /api/forge/github/webhook — pull_request_review', () => {
  it('records a changes-requested review', async () => {
    const prUrl = await seedTask({ id: 'tsk_3', status: 'ready_to_merge' });
    const res = await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
      pull_request: { html_url: prUrl },
    });
    expect(res.status).toBe(200);
    expect(await reviewDecisionOf('tsk_3')).toBe('changes_requested');
  });

  it('records an approved review', async () => {
    const prUrl = await seedTask({ id: 'tsk_approved', status: 'ready_to_merge' });
    await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { html_url: prUrl },
    });
    expect(await reviewDecisionOf('tsk_approved')).toBe('approved');
  });

  it('clears the review decision when a review is dismissed', async () => {
    const prUrl = await seedTask({ id: 'tsk_dismissed', status: 'ready_to_merge' });
    await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
      pull_request: { html_url: prUrl },
    });
    expect(await reviewDecisionOf('tsk_dismissed')).toBe('changes_requested');

    await postSigned('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
      pull_request: { html_url: prUrl },
    });
    expect(await reviewDecisionOf('tsk_dismissed')).toBeNull();
  });

  it('ignores review events for PRs Forge did not open', async () => {
    const res = await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { html_url: 'https://github.com/x/y/pull/999999' },
    });
    expect(res.status).toBe(200);
  });
});
