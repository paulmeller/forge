import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  approvedBy?: string | null;
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
    approvedBy: over.approvedBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return prUrl;
}

/**
 * Like seedTask, but lets a test pin an explicit prUrl and createdAt —
 * needed to construct a deliberate prUrl collision (two tasks sharing one
 * PR URL) with a controlled creation order.
 */
async function seedTaskWithPrUrl(over: {
  id: string;
  status: string;
  prUrl: string;
  createdAt: Date;
}): Promise<void> {
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
  });
  await db.insert(schema.tasks).values({
    id: over.id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: over.status as never,
    prUrl: over.prUrl,
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
  });
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

  it('clears a stale approvedBy when a ready_to_merge PR closes unmerged before auto-merge or the sweep act', async () => {
    // A human approved this Task (ready_to_merge, approvedBy set), then the
    // PR was closed on GitHub directly — before auto-merge's own sweep or
    // the reconciler's merging sweep ever touched it. That approval was for
    // a PR that's now dead; it must not survive onto the abandoned row.
    const prUrl = await seedTask({ id: 'tsk_2_approved', status: 'ready_to_merge', approvedBy: 'u1' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);
    const task = await getTask('tsk_2_approved');
    expect(task?.status).toBe('abandoned');
    expect(task?.approvedBy).toBeNull();
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
  });

  it('clears a stale approvedBy — the fast-path twin of the reconciler merging-sweep fix — when a merging task closes unmerged', async () => {
    // A task only reaches `merging` via auto-merge's tryMerge, which only
    // arms native auto-merge on a Task requireHumanApproval already let
    // through — so approvedBy can be non-null here. This handler is the
    // webhook fast path for the identical fact the reconciler's merging
    // sweep already clears approvedBy for; they must agree.
    const prUrl = await seedTask({ id: 'tsk_merging_approved', status: 'merging', approvedBy: 'u1' });
    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: prUrl, merged: false },
    });
    expect(res.status).toBe(200);
    const task = await getTask('tsk_merging_approved');
    expect(task?.status).toBe('needs_human');
    expect(task?.approvedBy).toBeNull();

    const events = await getLedgerEvents('tsk_merging_closed');
    const failedEvent = events.find((e) => e.eventType === 'auto_merge.failed');
    expect(failedEvent).toBeDefined();
    // Same payload shape reconciler.ts and auto-merge.ts write for this
    // eventType — { prNumber, reason/error } — not { prUrl }, so a future
    // consumer can read one shape regardless of which writer produced it.
    expect(failedEvent?.payload).toMatchObject({ reason: 'pr_closed_unmerged' });
    expect(failedEvent?.payload).toHaveProperty('prNumber');
    expect(failedEvent?.payload).not.toHaveProperty('prUrl');
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

describe('POST /api/forge/github/webhook — taskByPrUrl collision handling', () => {
  // `pr_url` has an index but no unique constraint (schema.ts), so more than
  // one Task can legitimately share a prUrl. taskByPrUrl must resolve that
  // deterministically — most recently created wins — rather than depending
  // on whatever order SQLite happens to return matching rows in. Without
  // the `orderBy(desc(createdAt))` this test fails: absent an ORDER BY,
  // SQLite returns matching rows in rowid/insertion order, so it would pick
  // the OLDER task instead.
  it('mutates the most recently created task when two tasks share a prUrl', async () => {
    const sharedPrUrl = 'https://github.com/acme/api/pull/collision-1';
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');

    // Insert the older task first so insertion order and recency order
    // disagree — a test that just happened to insert the newer one last
    // wouldn't distinguish "ordered by createdAt" from "ordered by rowid".
    await seedTaskWithPrUrl({
      id: 'tsk_collide_old',
      status: 'ready_to_merge',
      prUrl: sharedPrUrl,
      createdAt: older,
    });
    await seedTaskWithPrUrl({
      id: 'tsk_collide_new',
      status: 'ready_to_merge',
      prUrl: sharedPrUrl,
      createdAt: newer,
    });

    const res = await postSigned('pull_request', {
      action: 'closed',
      pull_request: { html_url: sharedPrUrl, merged: true },
    });
    expect(res.status).toBe(200);

    expect(await statusOf('tsk_collide_new')).toBe('merged');
    expect(await statusOf('tsk_collide_old')).toBe('ready_to_merge');
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

  it('is a no-op when a review event arrives for an already-terminal task', async () => {
    const prUrl = await seedTask({ id: 'tsk_review_terminal', status: 'merged' });
    const res = await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { html_url: prUrl },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe('already settled');
    // Untouched — no reviewDecision written onto a settled task.
    expect(await reviewDecisionOf('tsk_review_terminal')).toBeNull();
    expect(await statusOf('tsk_review_terminal')).toBe('merged');
  });

  it('leaves a previously stored decision untouched on an unrecognized review state', async () => {
    const prUrl = await seedTask({ id: 'tsk_unknown_state', status: 'ready_to_merge' });
    await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { html_url: prUrl },
    });
    expect(await reviewDecisionOf('tsk_unknown_state')).toBe('approved');

    // GitHub's review.state we don't model (e.g. a future state, or a typo
    // in a test payload) must not wipe out the standing 'approved' decision.
    const res = await postSigned('pull_request_review', {
      action: 'submitted',
      review: { state: 'some_unrecognized_state' },
      pull_request: { html_url: prUrl },
    });
    expect(res.status).toBe(200);
    expect(await reviewDecisionOf('tsk_unknown_state')).toBe('approved');
  });

  describe('CAS guard (compare-and-swap on the update)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Simulates the narrow TOCTOU window the CAS guard closes: something
    // else (the reconciler sweep, another delivery) commits a status change
    // to the Task between this handler's read and its write. We can't rely
    // on real thread interleaving in a single-process test, so we inject the
    // race deterministically at the exact point it matters: intercept the
    // one `db.update(tasks)` call this handler makes, perform the
    // "concurrent" status change first, then let the real CAS-guarded write
    // run against the now-changed row. Without `eq(tasks.status, task.status)`
    // in the guard this write would succeed anyway (matching on id alone)
    // and silently overwrite reviewDecision on a Task whose status moved out
    // from under it — this test fails if that guard is removed.
    it('does not apply the review decision when the task status changed underneath it', async () => {
      const prUrl = await seedTask({ id: 'tsk_cas_race', status: 'ready_to_merge' });

      const realUpdate = db.update.bind(db);
      const updateSpy = vi.spyOn(db, 'update').mockImplementationOnce((table: unknown) => {
        let setVals: Record<string, unknown> = {};
        let whereCond: unknown;
        return {
          set(vals: Record<string, unknown>) {
            setVals = vals;
            return this;
          },
          where(cond: unknown) {
            whereCond = cond;
            return this;
          },
          returning: () =>
            (async () => {
              // The "concurrent" write: something else moves the task to a
              // different, still-non-terminal status before this handler's
              // own guarded write executes.
              await realUpdate(schema.tasks)
                .set({ status: 'awaiting_ci', updatedAt: new Date() })
                .where(eq(schema.tasks.id, 'tsk_cas_race'));

              return realUpdate(table as typeof schema.tasks)
                .set(setVals)
                .where(whereCond as never)
                .returning();
            })(),
        } as never;
      });

      const res = await postSigned('pull_request_review', {
        action: 'submitted',
        review: { state: 'approved' },
        pull_request: { html_url: prUrl },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reason).toBe('already settled');

      const task = await getTask('tsk_cas_race');
      // The race's own status change landed...
      expect(task?.status).toBe('awaiting_ci');
      // ...but the review handler's write did not, because its guard no
      // longer matched the (now-changed) current status.
      expect(task?.reviewDecision).toBeNull();

      updateSpy.mockRestore();
    });
  });
});
