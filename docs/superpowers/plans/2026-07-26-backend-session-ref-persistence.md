# Backend Session Ref Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the live backend session handle to the database so it survives Cloud Run cold starts and scale-out, fixing a silent failure where the budget hard stop cancels an already-finished Gemini interaction instead of the running one.

**Architecture:** Add a nullable `backendSessionRef` column to `tasks`. Thread that ref through the `BackendAdapter` interface in both directions — passed *in* so a cold instance can target the right backend handle, returned *out* of `sendTurn` so the caller can persist a rotated handle. Adapters stay pure HTTP clients with no DB access; the Gemini adapter's in-memory map is demoted from source-of-truth to a cache. Separately, harden the two `cancelSession` call sites to verify the cancel actually took effect.

**Tech Stack:** TypeScript, Drizzle ORM (libSQL/Turso), Vitest, drizzle-kit for migrations.

## Global Constraints

- No new npm dependency.
- **Do NOT overwrite `tasks.sessionId`.** It is Forge's stable logical handle and is embedded in the Gemini adapter's synthetic event ids (`${sessionId}:step:${i}`); rotating it would orphan the poller's ledger-derived cursor (`gemini-managed-agents.ts` `findIndex`) and cause a full event-log replay.
- **Do NOT reset the Gemini adapter's `eventLog`.** The poller's cursor must remain findable in it.
- **Do NOT give any adapter DB access.** Adapters are pure HTTP clients. Persistence is the caller's job.
- The `cancelSession` hardening must preserve the existing best-effort contract: a failed or unverified cancel must **never** block the task's status change to `failed` (see the comment at `guardrails.ts:136`).
- Migrations must be generated with `pnpm --filter @forge/db db:generate` (drizzle-kit), never hand-written. A prior hand-written migration in this repo (`0004_auth_tables.sql`) was missing from `meta/_journal.json` and consequently never ran in *any* environment, including production.
- `managed-agents` and `gateway` hold zero in-memory per-session state (verified). They accept the new ref parameter and ignore it; only the Gemini adapter implements meaningful behavior for it.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/db/src/schema.ts` | Add `backendSessionRef` column to `tasks` | 1 |
| `packages/db/migrations/00XX_*.sql` + `meta/_journal.json` | Generated migration (drizzle-kit) | 1 |
| `apps/web/src/server/tick/adapters/types.ts` | `SendTurnInput`/`SendTurnResult` types; widened method signatures | 2 |
| `apps/web/src/server/tick/adapters/gemini-managed-agents.ts` | `resolvePhysicalId` helper; ref-aware methods; return rotated ref | 2 |
| `apps/web/src/server/tick/adapters/managed-agents.ts` | Accept and ignore ref; return `{}` | 2 |
| `apps/web/src/server/tick/adapters/gateway.ts` | Accept and ignore ref; return `{}` | 2 |
| `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts` | Ref-precedence + rotation unit tests | 2 |
| `apps/web/src/server/tick/poller.ts` | Pass `task.backendSessionRef` into `listEvents` | 2 |
| `apps/web/src/server/tick/ci.ts` | New `sendTurn` call shape; persist rotated ref inline | 2, 3 |
| `apps/web/src/server/tick/ai-review.ts` | New `sendTurn` call shape; thread ref into `rejectAndRetryTask` | 2, 3 |
| `apps/web/src/server/tick/verify.ts` | New `sendTurn` call shape; thread ref into `retry` | 2, 3 |
| `apps/web/src/server/tick/dispatcher.ts` | Persist initial `backendSessionRef` | 3 |
| `apps/web/src/server/tick/backend-session-ref.test.ts` | Real-DB persistence integration test | 3 |
| `apps/web/src/server/tick/budgets.ts` | Widen `Logger`; verify cancel; ledger event | 4 |
| `apps/web/src/server/tick/guardrails.ts` | Widen `Logger`; verify cancel; ledger event | 4 |
| `apps/web/src/server/tick/cancel-verify.test.ts` | Cancel-hardening tests | 4 |

**Why Task 2 is large and cannot be split further:** changing `sendTurn` from `(sessionId, text)` to a single object parameter is a breaking arity change. Every call site must move in the same commit or the build is red. Task 2 therefore covers the interface, all three adapters, and updating all call sites to the new *call shape* — but deliberately stops short of persisting anything. Task 3 adds the DB writes that make the ref actually live. Each task ends green.

---

## Task 1: Schema column and migration

**Files:**
- Modify: `packages/db/src/schema.ts` (the `tasks` table, near `sessionId: text('session_id')` at line 175)
- Create: `packages/db/migrations/00XX_<generated_name>.sql` (drizzle-kit picks the name)
- Modify: `packages/db/migrations/meta/_journal.json` (drizzle-kit updates it)

**Interfaces:**
- Produces: `tasks.backendSessionRef` — a nullable `text('backend_session_ref')` column. Task 2 reads it; Task 3 writes it.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, find this line inside the `tasks` table definition (line 175):

```ts
    sessionId: text('session_id'),
```

Add the new column directly beneath it:

```ts
    sessionId: text('session_id'),
    // The backend's *live* session handle. Usually identical to sessionId, but
    // Gemini rotates its interaction id on every turn, so this tracks which
    // physical handle is currently live. Persisted because the tick engine runs
    // on Cloud Run with --min-instances=0: in-memory adapter state does not
    // survive a cold start or a scale-out to another instance, and a stale
    // handle makes cancelSession silently cancel an already-finished session.
    // Nullable only for tasks created before this column existed.
    backendSessionRef: text('backend_session_ref'),
```

- [ ] **Step 2: Generate the migration**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm --filter @forge/db db:generate`
Expected: drizzle-kit prints that it created a new migration file under `packages/db/migrations/`, containing an `ALTER TABLE` adding `backend_session_ref`.

- [ ] **Step 3: Verify the migration is registered in the journal**

This repo has previously shipped a migration file that was never registered and therefore never ran anywhere. Confirm that did not happen here.

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && ls packages/db/migrations/*.sql | tail -3 && tail -20 packages/db/migrations/meta/_journal.json`

Expected: the newly generated `.sql` filename appears as a `"tag"` value in the last entry of `_journal.json`'s `entries` array. If it does **not**, stop and report — do not hand-edit the journal without flagging it, as that is the exact failure mode this step exists to catch.

Also confirm the generated SQL contains only an additive `ALTER TABLE ... ADD ...` (a nullable column needs no backfill and no table rebuild).

- [ ] **Step 4: Apply the migration locally and typecheck**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm --filter @forge/db db:migrate && pnpm --filter @forge/web typecheck`
Expected: migration applies without error; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): add tasks.backend_session_ref column"
```

---

## Task 2: Thread the session ref through the adapter interface

**Files:**
- Modify: `apps/web/src/server/tick/adapters/types.ts`
- Modify: `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`
- Modify: `apps/web/src/server/tick/adapters/managed-agents.ts`
- Modify: `apps/web/src/server/tick/adapters/gateway.ts`
- Modify: `apps/web/src/server/tick/poller.ts`
- Modify: `apps/web/src/server/tick/ci.ts`
- Modify: `apps/web/src/server/tick/ai-review.ts`
- Modify: `apps/web/src/server/tick/verify.ts`
- Test: `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts`

**Interfaces:**
- Consumes: `tasks.backendSessionRef` from Task 1 (read-only here; always `null` until Task 3 populates it).
- Produces:
  - `SendTurnInput = { sessionId: string; text: string; backendSessionRef?: string | null }`
  - `SendTurnResult = { backendSessionRef?: string }`
  - `sendTurn(input: SendTurnInput): Promise<SendTurnResult>`
  - `cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void>`
  - `getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>`
  - `ListEventsInput` gains `backendSessionRef?: string | null`
  Task 3 calls `sendTurn` and persists `result.backendSessionRef`. Task 4 calls `cancelSession` and `getSession` with a ref.

- [ ] **Step 1: Write the failing tests for ref precedence and rotation**

Append to `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts` (the file already defines `fakeFetch` and `input` at the top and calls `vi.unstubAllGlobals()` in `afterEach` — reuse those, do not redefine them):

```ts
describe('GeminiManagedAgentsAdapter backendSessionRef precedence', () => {
  it('prefers a passed-in backendSessionRef over its in-memory cache', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_third', status: 'in_progress' } }, // sendTurn
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    // Cache says v1_first; the caller supplies a newer, persisted ref.
    await adapter.sendTurn({ sessionId, text: 'go', backendSessionRef: 'v1_second' });

    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.previous_interaction_id).toBe('v1_second');
  });

  it('falls back to sessionId when the cache is empty and no ref is passed (cold-start path)', async () => {
    const { fn, calls } = fakeFetch([{ body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    // Fresh adapter — empty cache, exactly like a cold Cloud Run instance.
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.cancelSession('v1_orphan');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_orphan/cancel');
  });

  it('cancelSession targets the passed-in ref on a cold instance, not the original sessionId', async () => {
    const { fn, calls } = fakeFetch([{ body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.cancelSession('v1_original', 'v1_live');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live/cancel');
    expect(calls[0]!.url).not.toContain('v1_original');
  });

  it('getSession targets the passed-in ref on a cold instance', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_live', status: 'completed' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.getSession('v1_original', 'v1_live');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live');
  });

  it('listEvents targets the passed-in ref on a cold instance', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_live', status: 'in_progress', steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.listEvents({ sessionId: 'v1_original', backendSessionRef: 'v1_live' });

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live');
  });

  it('sendTurn returns the rotated interaction id for the caller to persist', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } },
      { body: { id: 'v1_second', status: 'in_progress' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    const result = await adapter.sendTurn({ sessionId, text: 'continue' });

    expect(result).toEqual({ backendSessionRef: 'v1_second' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters/gemini-managed-agents.test.ts`
Expected: FAIL — `sendTurn` currently takes `(sessionId, text)` positionally and returns `void`, so the object-argument calls and the `toEqual({ backendSessionRef: ... })` assertion both fail.

- [ ] **Step 3: Update the interface types**

In `apps/web/src/server/tick/adapters/types.ts`, add these two types immediately after the existing `CreateSessionResult` type:

```ts
export type SendTurnInput = {
  sessionId: string;
  text: string;
  /**
   * The backend's live session handle, when it differs from `sessionId`.
   * Gemini rotates its interaction id every turn; passing the persisted
   * value lets a cold instance target the correct one instead of falling
   * back to the original (already-finished) session.
   */
  backendSessionRef?: string | null;
};

export type SendTurnResult = {
  /** Set when this turn produced a new backend handle the caller must persist. */
  backendSessionRef?: string;
};
```

Add the same optional field to `ListEventsInput`:

```ts
export type ListEventsInput = {
  sessionId: string;
  /** Cursor — return events with id > this. Adapter decides the concrete pagination. */
  afterEventId?: string;
  /** See SendTurnInput.backendSessionRef. */
  backendSessionRef?: string | null;
};
```

Change the three method signatures in the `BackendAdapter` interface:

```ts
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
  listEvents(input: ListEventsInput): Promise<ListEventsResult>;
  getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>;
  cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void>;
```

- [ ] **Step 4: Update the Gemini adapter**

In `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`, add `SendTurnInput` and `SendTurnResult` to the existing type-only import from `./types`.

Add this private helper method to the class, directly above `createSession`:

```ts
  /**
   * Which physical Gemini interaction to act on. Precedence: the caller's
   * persisted ref (authoritative, survives restarts) → this instance's cache
   * (fast path while warm) → the original sessionId (last resort, only for
   * tasks created before backendSessionRef existed).
   */
  private resolvePhysicalId(sessionId: string, backendSessionRef?: string | null): string {
    return backendSessionRef ?? this.latestInteractionId.get(sessionId) ?? sessionId;
  }
```

Replace `sendTurn` entirely:

```ts
  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const physicalId = this.resolvePhysicalId(input.sessionId, input.backendSessionRef);
    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', {
      model: this.model,
      background: true,
      previous_interaction_id: physicalId,
      input: input.text,
    });
    this.latestInteractionId.set(input.sessionId, interaction.id);
    return { backendSessionRef: interaction.id };
  }
```

In `listEvents`, replace only its first line:

```ts
    const physicalId = this.resolvePhysicalId(input.sessionId, input.backendSessionRef);
```

Replace `getSession` and `cancelSession`'s signatures and their `physicalId` lines:

```ts
  async getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult> {
    const physicalId = this.resolvePhysicalId(sessionId, backendSessionRef);
    const interaction = await this.request<GeminiInteraction>(
      'GET',
      `/v1beta/interactions/${physicalId}`,
    );
    return {
      sessionId,
      status: normalizeStatus(interaction.status),
      stopReasonType: interaction.status === 'requires_action' ? 'requires_action' : undefined,
    };
  }

  async cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void> {
    const physicalId = this.resolvePhysicalId(sessionId, backendSessionRef);
    await this.request('POST', `/v1beta/interactions/${physicalId}/cancel`);
  }
```

Leave every other part of `listEvents` untouched — in particular its use of `input.sessionId` (not `physicalId`) as the key for `eventLog`, `processedStepCount`, `terminalEmitted`, and `lastSeenUsage`, and as the prefix of synthetic event ids. Those must stay keyed by the stable logical id.

- [ ] **Step 5: Update the managed-agents adapter**

In `apps/web/src/server/tick/adapters/managed-agents.ts`, add `SendTurnInput` and `SendTurnResult` to the type-only import from `./types`, then replace `sendTurn`:

```ts
  // backendSessionRef is unused: Managed Agents session ids are stable for the
  // life of the session, so there is never a rotated handle to track.
  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    await this.client.beta.sessions.events.send(input.sessionId, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: input.text }],
        },
      ],
    } as never);
    return {};
  }
```

Change `getSession` and `cancelSession` to accept and ignore the ref:

```ts
  async getSession(sessionId: string, _backendSessionRef?: string | null): Promise<GetSessionResult> {
```

```ts
  async cancelSession(sessionId: string, _backendSessionRef?: string | null): Promise<void> {
```

Leave both method bodies unchanged.

- [ ] **Step 6: Update the gateway adapter**

In `apps/web/src/server/tick/adapters/gateway.ts`, add `SendTurnInput` and `SendTurnResult` to the type-only import from `./types`, then replace `sendTurn`:

```ts
  // backendSessionRef is unused: gateway session ids are stable for the life
  // of the session, so there is never a rotated handle to track.
  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    await this.request('POST', `/v1/sessions/${input.sessionId}/events`, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: input.text }],
        },
      ],
    });
    return {};
  }
```

Change `getSession` and `cancelSession` to accept and ignore the ref:

```ts
  async getSession(sessionId: string, _backendSessionRef?: string | null): Promise<GetSessionResult> {
```

```ts
  async cancelSession(sessionId: string, _backendSessionRef?: string | null): Promise<void> {
```

Leave both method bodies unchanged.

- [ ] **Step 7: Add a contract test that non-rotating adapters return no ref**

Append to `apps/web/src/server/tick/adapters/adapter-contract.test.ts`, after the existing `adapterSuite(...)` registrations. This pins the invariant that only a rotating backend reports a new handle:

```ts
describe('non-rotating adapters report no rotated handle', () => {
  it('ManagedAgentsAdapter.sendTurn returns an empty result', async () => {
    const send = vi.fn(async () => ({}));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'test-key',
      environmentId: 'test-env',
      client: { beta: { sessions: { events: { send } } } } as never,
    });

    const result = await adapter.sendTurn({ sessionId: 's1', text: 'hi' });

    expect(result).toEqual({});
    expect(send).toHaveBeenCalledOnce();
  });

  it('GatewayAdapter.sendTurn returns an empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
    );
    const adapter = new GatewayAdapter({ baseUrl: 'https://gw.test', apiKey: 'k' });

    const result = await adapter.sendTurn({ sessionId: 's1', text: 'hi' });

    expect(result).toEqual({});
    vi.unstubAllGlobals();
  });
});
```

Add `vi` to the existing `vitest` import at the top of that file if it is not already there. If `ManagedAgentsAdapter`'s constructor does not accept a `client` override, or `GatewayAdapter`'s requires additional options, adjust the construction to match the real signatures rather than changing the adapters — the assertion being tested is only the `{}` return value.

- [ ] **Step 8: Run the adapter tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters`
Expected: PASS. `adapter-contract.test.ts`'s existing `adapterSuite` asserts only `typeof adapter.X === 'function'`, so the signature changes themselves need no updates there.

- [ ] **Step 9: Update the call sites to the new call shape**

These four edits only change *how* the methods are called. Persisting the returned ref is Task 3.

In `apps/web/src/server/tick/poller.ts`, change the `listEvents` call (around line 90):

```ts
  const { events } = await adapter.listEvents({
    sessionId: task.sessionId,
    afterEventId: latestLedger?.sourceEventId ?? undefined,
    backendSessionRef: task.backendSessionRef,
  });
```

In `apps/web/src/server/tick/ci.ts` (around line 201):

```ts
    await adapter.sendTurn({
      sessionId: task.sessionId,
      text: prompt,
      backendSessionRef: task.backendSessionRef,
    });
```

In `apps/web/src/server/tick/ai-review.ts` (around line 215):

```ts
        await adapter.sendTurn({
          sessionId: task.sessionId,
          text: review.feedback,
          backendSessionRef: task.backendSessionRef,
        });
```

In `apps/web/src/server/tick/verify.ts` (around line 241):

```ts
        await getAdapter(mission.backend).sendTurn({
          sessionId: task.sessionId,
          text: buildVerifyFeedback(verdict.missing ?? ''),
          backendSessionRef: task.backendSessionRef,
        });
```

- [ ] **Step 10: Typecheck and run the full suite**

Run: `cd apps/web && pnpm typecheck && pnpm vitest run`
Expected: both PASS. If typecheck reports a call site this plan missed, fix it the same way (pass the object form) and note it in the report.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/server/tick/adapters apps/web/src/server/tick/poller.ts apps/web/src/server/tick/ci.ts apps/web/src/server/tick/ai-review.ts apps/web/src/server/tick/verify.ts
git commit -m "feat(tick): thread backendSessionRef through the adapter interface"
```

---

## Task 3: Persist the session ref

**Files:**
- Modify: `apps/web/src/server/tick/dispatcher.ts` (the `db.update` around lines 305-317)
- Modify: `apps/web/src/server/tick/ci.ts`
- Modify: `apps/web/src/server/tick/ai-review.ts`
- Modify: `apps/web/src/server/tick/verify.ts`
- Test: `apps/web/src/server/tick/backend-session-ref.test.ts` (new)

**Interfaces:**
- Consumes: `sendTurn(input: SendTurnInput): Promise<SendTurnResult>` from Task 2; `tasks.backendSessionRef` from Task 1.
- Produces: nothing consumed by later tasks. Task 4 is independent.

- [ ] **Step 1: Write the failing persistence test**

Create `apps/web/src/server/tick/backend-session-ref.test.ts`. This uses the real-DB integration pattern (throwaway libSQL file + real drizzle migration) already used by `apps/web/src/app/(app)/setup/actions.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { missions, tasks } from '@forge/db';

const DB_PATH = vi.hoisted(() => `/tmp/forge-backend-session-ref-${process.pid}.db`);

vi.mock('@/lib/db', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  return { db: drizzle(createClient({ url: `file:${DB_PATH}` })) };
});

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(createClient({ url: `file:${DB_PATH}` }));
  await migrate(db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
});

afterAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe('backendSessionRef persistence', () => {
  it('stores a rotated ref so it survives a process restart', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = new Date();

    await db.insert(missions).values({
      id: missionId,
      userId: 'user_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'gemini-managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'rule-based',
      targetRepos: ['owner/repo'],
      concurrencyCap: 1,
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: taskId,
      missionId,
      repo: 'owner/repo',
      baseBranch: 'main',
      status: 'awaiting_ci',
      sessionId: 'v1_first',
      backendSessionRef: 'v1_first',
      createdAt: now,
      updatedAt: now,
    });

    // What a sendTurn rotation writes.
    await db
      .update(tasks)
      .set({ backendSessionRef: 'v1_second', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    // sessionId must NOT rotate — it anchors the adapter's synthetic event ids.
    expect(row!.sessionId).toBe('v1_first');
    expect(row!.backendSessionRef).toBe('v1_second');
  });

  it('defaults backendSessionRef to null for a task that never set it', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = new Date();

    await db.insert(missions).values({
      id: missionId,
      userId: 'user_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'rule-based',
      targetRepos: ['owner/repo'],
      concurrencyCap: 1,
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: taskId,
      missionId,
      repo: 'owner/repo',
      baseBranch: 'main',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row!.backendSessionRef).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/server/tick/backend-session-ref.test.ts`
Expected: FAIL if Task 1's column or migration is missing. If Task 1 landed correctly this test may PASS immediately — that is acceptable; it is a regression guard for the column's existence and the "sessionId must not rotate" invariant. Note in the report which it did.

- [ ] **Step 3: Persist the initial ref in the dispatcher**

In `apps/web/src/server/tick/dispatcher.ts`, find the `db.update` that runs after `createSession` (around line 305) and add one line beside the existing `sessionId,`:

```ts
    .set({
      status: 'running',
      sessionId,
      // Initially identical to sessionId. Backends that rotate their handle
      // (Gemini) update this on every turn; stable backends never change it.
      backendSessionRef: sessionId,
      updatedAt: now,
```

Leave the rest of the `.set({...})` object, including the conditional `acceptanceCriteria` spread, exactly as it is.

- [ ] **Step 4: Persist the rotated ref in ci.ts**

`ci.ts` already performs an inline `db.update` right after `sendTurn`, so the ref folds into it. Capture the result inside the existing `try` block (around line 199-215):

```ts
  let rotatedRef: string | undefined;
  try {
    const adapter = getAdapter(mission.backend);
    const result = await adapter.sendTurn({
      sessionId: task.sessionId,
      text: prompt,
      backendSessionRef: task.backendSessionRef,
    });
    rotatedRef = result.backendSessionRef;
  } catch {
    return false;
  }

  const now = new Date();
  await db
    .update(tasks)
    .set({
      retryCount: task.retryCount + 1,
      ...(rotatedRef ? { backendSessionRef: rotatedRef } : {}),
      // Stay at awaiting_ci — once the agent pushes, GitHub will trigger a
      // new check run and we'll re-evaluate on the next ci poll.
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
```

- [ ] **Step 5: Persist the rotated ref in ai-review.ts**

Here the following DB write lives inside the `rejectAndRetryTask` helper, so write the ref with a small dedicated update instead of threading a new parameter through that helper. Replace the `try`/`catch` around line 212-222:

```ts
    if (task.sessionId) {
      try {
        const adapter = getAdapter(mission.backend);
        const result = await adapter.sendTurn({
          sessionId: task.sessionId,
          text: review.feedback,
          backendSessionRef: task.backendSessionRef,
        });
        if (result.backendSessionRef) {
          await db
            .update(tasks)
            .set({ backendSessionRef: result.backendSessionRef, updatedAt: new Date() })
            .where(eq(tasks.id, task.id));
        }
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'ai-review:send_turn_failed',
        );
      }
    }
```

A thrown `sendTurn` leaves the stored ref unchanged, which is correct — no new interaction was created.

- [ ] **Step 6: Persist the rotated ref in verify.ts**

Same shape as Step 5 — the subsequent write is inside the `retry` helper, so use a dedicated update. Replace the `try`/`catch` around line 239-251:

```ts
    if (task.sessionId) {
      try {
        const result = await getAdapter(mission.backend).sendTurn({
          sessionId: task.sessionId,
          text: buildVerifyFeedback(verdict.missing ?? ''),
          backendSessionRef: task.backendSessionRef,
        });
        if (result.backendSessionRef) {
          await db
            .update(tasks)
            .set({ backendSessionRef: result.backendSessionRef, updatedAt: new Date() })
            .where(eq(tasks.id, task.id));
        }
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'verify:send_turn_failed',
        );
      }
    }
```

Check that `db`, `tasks`, and `eq` are already imported in both `ai-review.ts` and `verify.ts`; add whichever is missing.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd apps/web && pnpm typecheck && pnpm vitest run`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/tick/dispatcher.ts apps/web/src/server/tick/ci.ts apps/web/src/server/tick/ai-review.ts apps/web/src/server/tick/verify.ts apps/web/src/server/tick/backend-session-ref.test.ts
git commit -m "feat(tick): persist backendSessionRef on dispatch and turn rotation"
```

---

## Task 4: Verify that cancellation actually took effect

**Files:**
- Modify: `apps/web/src/server/tick/budgets.ts`
- Modify: `apps/web/src/server/tick/guardrails.ts`
- Test: `apps/web/src/server/tick/cancel-verify.test.ts` (new)

**Interfaces:**
- Consumes: `cancelSession(sessionId, backendSessionRef?)` and `getSession(sessionId, backendSessionRef?)` from Task 2; `tasks.backendSessionRef` from Task 1.
- Produces: two new ledger event types, `budgets.hard_stop_cancel_unverified` and `guardrails.cancel_unverified`.

**Why this is needed:** both call sites already `try`/`catch` a *thrown* error. The real bug throws nothing — cancelling an already-finished interaction returns HTTP 200. A successful call to the wrong target is indistinguishable from success, so the only way to detect it is to read the session's status back.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/tick/cancel-verify.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { verifyCancelled } from './cancel-verify';

describe('verifyCancelled', () => {
  it('returns true when the session reports terminated', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'terminated' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(true);
    expect(adapter.getSession).toHaveBeenCalledWith('s1', 'ref1');
  });

  it('returns false when the session is still running — the silent-failure case', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'running' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(false);
  });

  it('returns false when the status read itself throws, rather than propagating', async () => {
    const adapter = {
      getSession: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    await expect(verifyCancelled(adapter, 's1', null)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/server/tick/cancel-verify.test.ts`
Expected: FAIL — `Cannot find module './cancel-verify'`.

- [ ] **Step 3: Create the shared helper**

Create `apps/web/src/server/tick/cancel-verify.ts`:

```ts
import type { GetSessionResult } from './adapters';

type SessionReader = {
  getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>;
};

/**
 * Reads a session's status back after a cancel to confirm it actually stopped.
 *
 * Cancelling an already-finished backend session returns HTTP 200 and throws
 * nothing, so a try/catch around cancelSession cannot detect that the wrong
 * session was targeted. Reading the status back can.
 *
 * Never throws: a failed status read means "unverified", not "still running",
 * and must not disturb the caller's best-effort cancel contract.
 */
export async function verifyCancelled(
  adapter: SessionReader,
  sessionId: string,
  backendSessionRef?: string | null,
): Promise<boolean> {
  try {
    const session = await adapter.getSession(sessionId, backendSessionRef);
    return session.status === 'terminated';
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/server/tick/cancel-verify.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Widen both local Logger types**

`budgets.ts` and `guardrails.ts` each declare a local `Logger` type with only `info` and `warn`. The real logger passed in from `tick.ts` is a pino instance that already has `error`, and `tick.ts`'s own `Logger` type already declares it — so widening these two requires no call-site change.

In `apps/web/src/server/tick/budgets.ts` (line 11) and `apps/web/src/server/tick/guardrails.ts` (line 19), change:

```ts
type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};
```

to:

```ts
type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};
```

- [ ] **Step 6: Harden the budgets hard stop**

In `apps/web/src/server/tick/budgets.ts`, replace the `try`/`catch` around line 212-222 with:

```ts
  for (const task of inflight) {
    if (task.sessionId) {
      let cancelled = false;
      try {
        const adapter = getAdapter(mission.backend);
        await adapter.cancelSession(task.sessionId, task.backendSessionRef);
        cancelled = await verifyCancelled(adapter, task.sessionId, task.backendSessionRef);
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'budgets:hard_stop_cancel_failed',
        );
      }
      if (!cancelled) {
        // The agent may still be burning budget. Loud, and auditable in the UI.
        log.error(
          { taskId: task.id, missionId: mission.id },
          'budgets:hard_stop_cancel_unverified',
        );
        await db.insert(ledgerEvents).values({
          id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          missionId: mission.id,
          taskId: task.id,
          eventType: 'budgets.hard_stop_cancel_unverified',
          payload: { sessionId: task.sessionId, backendSessionRef: task.backendSessionRef },
        });
      }
    }
```

Leave the `db.update` that follows exactly as it is — the task is still marked `failed` whether or not the cancel verified.

Add the import: `import { verifyCancelled } from './cancel-verify';`

- [ ] **Step 7: Harden the guardrails cancel**

In `apps/web/src/server/tick/guardrails.ts`, replace the `try`/`catch` around line 136-146 with:

```ts
    // Best-effort cancel — a failure here must NOT block the status change.
    if (task.sessionId) {
      let cancelled = false;
      try {
        const adapter = getAdapter(mission.backend);
        await adapter.cancelSession(task.sessionId, task.backendSessionRef);
        cancelled = await verifyCancelled(adapter, task.sessionId, task.backendSessionRef);
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'guardrails:cancel_failed',
        );
      }
      if (!cancelled) {
        log.error({ taskId: task.id, reason }, 'guardrails:cancel_unverified');
        await db.insert(ledgerEvents).values({
          id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          missionId: mission.id,
          taskId: task.id,
          eventType: 'guardrails.cancel_unverified',
          payload: { sessionId: task.sessionId, backendSessionRef: task.backendSessionRef, reason },
        });
      }
    }
```

Leave the `db.update` that follows exactly as it is.

Add the import: `import { verifyCancelled } from './cancel-verify';`

Confirm `mission` is in scope at this point in `runGuardrails`; if the loop variable is named differently, use the correct one for `missionId`.

- [ ] **Step 8: Typecheck and run the full suite**

Run: `cd apps/web && pnpm typecheck && pnpm vitest run`
Expected: both PASS.

- [ ] **Step 9: Run the whole workspace suite**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm -r test`
Expected: PASS across all packages.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/tick/cancel-verify.ts apps/web/src/server/tick/cancel-verify.test.ts apps/web/src/server/tick/budgets.ts apps/web/src/server/tick/guardrails.ts
git commit -m "feat(tick): verify cancellation took effect instead of assuming it"
```

---

## After all tasks: whole-branch review

Dispatch a final whole-branch review covering the full diff. Pay particular attention to:

- Does any code path still rely on the Gemini adapter's in-memory `latestInteractionId` as a source of truth rather than a cache?
- Is `tasks.sessionId` still never written after dispatch? (It must not rotate — synthetic event ids and the poller cursor depend on it.)
- Do both `cancelSession` call sites still mark the task `failed` on every path, including when verification fails?
- Is the generated migration registered in `meta/_journal.json`?
