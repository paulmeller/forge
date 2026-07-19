# Consolidate apps/tick into apps/web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the forge-tick Fastify service into apps/web as a single self-hosted Next.js 16 app, per `docs/superpowers/specs/2026-07-19-consolidate-tick-into-web-design.md`.

**Architecture:** tick's ~24 framework-agnostic source files copy (not move — apps/tick keeps working until cutover is verified) into `apps/web/src/server/tick/`; its 3 Fastify routes become Next.js route handlers; env vars merge into web's lazy-getter `env` object; `syncSkillsToDb()` re-homes to `instrumentation.ts`. apps/tick is deleted only in the final task, after workflows stop building it.

**Tech Stack:** Next.js 16 (standalone output, self-hosted), pino, jose, @octokit/rest, yaml, drizzle/libsql, vitest.

## Global Constraints

- Next.js `^16.2` with `eslint-config-next` bumped to match (spec rollout step 1).
- The rewritten stream route MUST retain `withAuth()` (spec §B — it fronts a raw `x-api-key` Anthropic call).
- Copied tick code changes ONLY what the spec's §A "deliberate changes" list names: import paths, `tick.ts` logger type, `skill-loader.ts` `SKILLS_DIR`, test `migrationsFolder` paths. Everything else byte-identical.
- New web deps limited to: `@octokit/rest`, `jose`, `yaml`, `pino`. No `fastify`/`@fastify/sensible`.
- Numeric/boolean env getters keep tick's coercions (`Number(x ?? default)`, `=== 'true'`).
- apps/tick stays intact and green until Task 8; every task ends with `pnpm typecheck` and `pnpm test` green across the whole workspace.

---

### Task 1: Next.js 16 upgrade

**Files:**
- Modify: `apps/web/package.json` (`next`, `eslint-config-next`)

**Interfaces:**
- Produces: apps/web building/running on Next 16 standalone; all later tasks assume it.

- [ ] **Step 1: Bump versions**

```bash
cd apps/web
pnpm add next@^16.2.0
pnpm add -D eslint-config-next@^16.2.0
```

- [ ] **Step 2: Build + typecheck + test**

Run: `pnpm --filter @forge/web typecheck && pnpm --filter @forge/web test && pnpm --filter @forge/web build`
Expected: all pass; build output still reports standalone. If the build fails on fumadocs peer-dependency errors against Next 16, run `pnpm --filter @forge/web add fumadocs-core@latest fumadocs-ui@latest fumadocs-mdx@latest` and re-run the build; any other failure is a BLOCKED escalation, not something to patch ad hoc.

- [ ] **Step 3: Smoke-test dev server**

Run: `pnpm --filter @forge/web dev` in background; curl `http://localhost:3100/api/health` → 200, `http://localhost:3100/docs` → 200. Kill the server.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): upgrade to Next.js 16"
```

### Task 2: Dependencies, env merge, vitest alias

**Files:**
- Modify: `apps/web/package.json` (add `@octokit/rest`, `jose`, `yaml`, `pino`)
- Modify: `apps/web/src/lib/env.ts` (new getters)
- Modify: `apps/web/vitest.config.ts` (add `@` alias)
- Test: `apps/web/src/lib/env.test.ts` (new)

**Interfaces:**
- Produces: `env.ANTHROPIC_BASE_URL: string`, `env.GATEWAY_API_KEY/GATEWAY_ENVIRONMENT_ID/FORGE_MA_ENVIRONMENT_ID/FORGE_MA_DEFAULT_VAULT_ID: string | undefined`, `env.TASK_RETRY_MAX/TASK_MAX_TURNS/TASK_NO_PROGRESS_TOKENS/TASK_MAX_TOKENS/BUDGET_HARD_STOP_PCT/VERIFY_RETRY_MAX/GATE_STALL_MS: number`, `env.VERIFY_MODEL/LOG_LEVEL/FORGE_SKILLS_DIR: string`, `env.TICK_EXPECTED_AUDIENCE/TICK_EXPECTED_ISSUER_EMAIL: string | undefined`, `env.TICK_ALLOW_UNAUTHENTICATED: boolean`. Defaults identical to `apps/tick/src/env.ts:24-53` (`ANTHROPIC_BASE_URL` → `'https://api.anthropic.com'`, `TASK_RETRY_MAX` → 3, `TASK_MAX_TURNS` → 30, `TASK_NO_PROGRESS_TOKENS` → 200_000, `TASK_MAX_TOKENS` → 0, `BUDGET_HARD_STOP_PCT` → 100, `VERIFY_RETRY_MAX` → 2, `VERIFY_MODEL` → `'claude-haiku-4-5'`, `GATE_STALL_MS` → 1_800_000, `LOG_LEVEL` → `'info'`). New: `FORGE_SKILLS_DIR` defaults to `resolve(process.cwd(), '../../skills')`.
- Produces: vitest resolves `@/...` imports (alias to `./src`), needed by every later task's tests.

- [ ] **Step 1: Add deps**

```bash
pnpm --filter @forge/web add @octokit/rest jose yaml pino
```

- [ ] **Step 2: Write the failing env test** — `apps/web/src/lib/env.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { env } from '@/lib/env';

describe('tick env getters', () => {
  it('coerces numeric vars with tick defaults', () => {
    expect(env.TASK_RETRY_MAX).toBe(3);
    expect(env.TASK_MAX_TURNS).toBe(30);
    expect(env.TASK_NO_PROGRESS_TOKENS).toBe(200_000);
    expect(env.TASK_MAX_TOKENS).toBe(0);
    expect(env.BUDGET_HARD_STOP_PCT).toBe(100);
    expect(env.VERIFY_RETRY_MAX).toBe(2);
    expect(env.GATE_STALL_MS).toBe(1_800_000);
  });

  it('reads numeric overrides from process.env at access time', () => {
    process.env.TASK_RETRY_MAX = '7';
    expect(env.TASK_RETRY_MAX).toBe(7);
    delete process.env.TASK_RETRY_MAX;
  });

  it('coerces TICK_ALLOW_UNAUTHENTICATED as strict boolean', () => {
    expect(env.TICK_ALLOW_UNAUTHENTICATED).toBe(false);
    process.env.TICK_ALLOW_UNAUTHENTICATED = 'true';
    expect(env.TICK_ALLOW_UNAUTHENTICATED).toBe(true);
    delete process.env.TICK_ALLOW_UNAUTHENTICATED;
  });

  it('defaults ANTHROPIC_BASE_URL and VERIFY_MODEL', () => {
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.VERIFY_MODEL).toBe('claude-haiku-4-5');
  });
});
```

- [ ] **Step 3: Add the `@` alias to `apps/web/vitest.config.ts` so the test file can even load**

```typescript
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @forge/web vitest run src/lib/env.test.ts`
Expected: FAIL — `env.TASK_RETRY_MAX` is `undefined` (getter doesn't exist yet).

- [ ] **Step 5: Add the getters to `apps/web/src/lib/env.ts`** — append inside the existing `env` object, following its getter style; add `import { resolve } from 'node:path';` at the top:

```typescript
  // ── merged from apps/tick/src/env.ts (consolidation spec §A) ──
  get ANTHROPIC_BASE_URL(): string {
    return optional('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com';
  },
  get GATEWAY_API_KEY(): string | undefined {
    return optional('GATEWAY_API_KEY');
  },
  get GATEWAY_ENVIRONMENT_ID(): string | undefined {
    return optional('GATEWAY_ENVIRONMENT_ID');
  },
  get FORGE_MA_ENVIRONMENT_ID(): string | undefined {
    return optional('FORGE_MA_ENVIRONMENT_ID');
  },
  get FORGE_MA_DEFAULT_VAULT_ID(): string | undefined {
    return optional('FORGE_MA_DEFAULT_VAULT_ID');
  },
  get TASK_RETRY_MAX(): number {
    return Number(optional('TASK_RETRY_MAX') ?? 3);
  },
  get TASK_MAX_TURNS(): number {
    return Number(optional('TASK_MAX_TURNS') ?? 30);
  },
  get TASK_NO_PROGRESS_TOKENS(): number {
    return Number(optional('TASK_NO_PROGRESS_TOKENS') ?? 200_000);
  },
  get TASK_MAX_TOKENS(): number {
    return Number(optional('TASK_MAX_TOKENS') ?? 0); // 0 = unbounded
  },
  get BUDGET_HARD_STOP_PCT(): number {
    return Number(optional('BUDGET_HARD_STOP_PCT') ?? 100);
  },
  get VERIFY_RETRY_MAX(): number {
    return Number(optional('VERIFY_RETRY_MAX') ?? 2);
  },
  get VERIFY_MODEL(): string {
    return optional('VERIFY_MODEL') ?? 'claude-haiku-4-5'; // checker ≠ maker
  },
  get GATE_STALL_MS(): number {
    return Number(optional('GATE_STALL_MS') ?? 1_800_000); // 30 min gate stall sweep
  },
  get LOG_LEVEL(): string {
    return optional('LOG_LEVEL') ?? 'info';
  },
  get TICK_EXPECTED_AUDIENCE(): string | undefined {
    return optional('TICK_EXPECTED_AUDIENCE');
  },
  get TICK_EXPECTED_ISSUER_EMAIL(): string | undefined {
    return optional('TICK_EXPECTED_ISSUER_EMAIL');
  },
  get TICK_ALLOW_UNAUTHENTICATED(): boolean {
    return optional('TICK_ALLOW_UNAUTHENTICATED') === 'true';
  },
  get FORGE_SKILLS_DIR(): string {
    // Monorepo dev/test default: cwd is apps/web → repo-root skills/.
    // The production image sets this explicitly (Task 7).
    return optional('FORGE_SKILLS_DIR') ?? resolve(process.cwd(), '../../skills');
  },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @forge/web vitest run src/lib/env.test.ts` → PASS; then `pnpm typecheck && pnpm test` (workspace) → green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/env.ts apps/web/src/lib/env.test.ts apps/web/vitest.config.ts
git commit -m "feat(web): tick env getters, deps, and vitest @ alias for consolidation"
```

### Task 3: Copy tick code into apps/web/src/server/tick/

**Files:**
- Create: `apps/web/src/server/tick/**` (24 source + 22 test files, listed in Step 1)
- apps/tick is NOT touched.

**Interfaces:**
- Consumes: `env` getters and vitest alias from Task 2.
- Produces: `runTick(log: Logger): Promise<TickResult>` at `apps/web/src/server/tick/tick.ts` where `Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }`; `verifyCloudSchedulerOidc(authHeader: string | undefined): Promise<void>` at `.../oidc.ts`; `syncSkillsToDb(): Promise<{ inserted: number; updated: number }>` at `.../skill-loader.ts`. Tasks 4-6 import these.

- [ ] **Step 1: Copy the files**

```bash
mkdir -p apps/web/src/server/tick
cp -R apps/tick/src/. apps/web/src/server/tick/
cd apps/web/src/server/tick
rm server.ts index.ts bootstrap.ts db.ts env.ts server.test.ts
ls *.ts adapters/*.ts | wc -l   # expect 46 (24 source + 22 tests)
```

The 24 sources: `adapters/{index,types,managed-agents,gateway}.ts`, `agents-md.ts`, `ai-review.ts`, `auto-merge.ts`, `budgets.ts`, `ci.ts`, `dag.ts`, `dispatcher.ts`, `gate-flags.ts`, `gates.ts`, `guardrails.ts`, `memory.ts`, `oidc.ts`, `poller.ts`, `prompt.ts`, `reconciler.ts`, `skill-loader.ts`, `state.ts`, `tick.ts`, `triage-verdict.ts`, `verify.ts`. The 22 tests: every `*.test.ts` except the deleted `server.test.ts` (includes `adapters/adapter-contract.test.ts`, `adapters/managed-agents.test.ts`, `budgets.integration.test.ts`, `reconciler.integration.test.ts`, `gate-flags.test.ts`).

- [ ] **Step 2: Rewrite `./db` and `./env` imports to web's modules** (in the copies only)

```bash
cd apps/web/src/server/tick
# static + dynamic imports, top-level files
perl -pi -e "s|from '\./db'|from '\@/lib/db'|g; s|from '\./env'|from '\@/lib/env'|g; s|import\('\./db'\)|import('\@/lib/db')|g" *.ts
# adapters/ files import one level up
perl -pi -e "s|from '\.\./db'|from '\@/lib/db'|g; s|from '\.\./env'|from '\@/lib/env'|g" adapters/*.ts
grep -rn "from '\./db'\|from '\./env'\|from '\.\./db'\|from '\.\./env'\|import('\./db')" . && echo LEFTOVERS || echo CLEAN
```

Expected: `CLEAN`.

- [ ] **Step 3: The four deliberate content changes (spec §A)**

(a) `tick.ts` — replace line 1 `import type { FastifyBaseLogger } from 'fastify';` with a structural type, and change the `runTick` signature to use it:

```typescript
type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};
```

```typescript
export async function runTick(log: Logger): Promise<TickResult> {
```

(b) `skill-loader.ts` — replace the `__filename`/`__dirname`/`SKILLS_DIR` block (`fileURLToPath` import becomes unused; remove it):

```typescript
import { env } from '@/lib/env';
// … existing imports stay …

// Repo-root skills/ directory; overridable for the deployed image (spec §A).
const SKILLS_DIR = env.FORGE_SKILLS_DIR;
```

(c) `reconciler.test.ts` and `reconciler.integration.test.ts` — `migrationsFolder` gains two `../`:

```typescript
      migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
```

(d) Same fix in `budgets.integration.test.ts` and `gate-flags.test.ts` (added after the spec was written; same `__dirname` bug class):

```typescript
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
```

- [ ] **Step 4: Run the copied suite + workspace checks**

Run: `pnpm --filter @forge/web vitest run src/server/tick` → 22 files pass. Then `pnpm typecheck && pnpm test` (workspace root) → green, including apps/tick's own untouched suite.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/tick
git commit -m "feat(web): vendor tick engine into src/server/tick (copy; apps/tick untouched until cutover)"
```

### Task 4: POST /api/tick route

**Files:**
- Create: `apps/web/src/app/api/tick/route.ts`
- Test: `apps/web/src/app/api/tick/route.test.ts`

**Interfaces:**
- Consumes: `runTick`, `verifyCloudSchedulerOidc` (Task 3), `env.LOG_LEVEL` (Task 2).
- Produces: `POST /api/tick` — 401 on failed OIDC, else 200 with the `TickResult` JSON. Task 7's Cloud Scheduler cutover targets it.

- [ ] **Step 1: Write the failing test** — `apps/web/src/app/api/tick/route.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTick = vi.fn(async () => ({ durationMs: 1 }));
vi.mock('@/server/tick/tick', () => ({ runTick }));

import { POST } from './route';

describe('POST /api/tick', () => {
  beforeEach(() => {
    runTick.mockClear();
    delete process.env.TICK_ALLOW_UNAUTHENTICATED;
  });

  it('401s without a bearer token when auth is required', async () => {
    const res = await POST(new Request('http://x/api/tick', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('runs a tick and returns its result when unauthenticated mode is on', async () => {
    process.env.TICK_ALLOW_UNAUTHENTICATED = 'true';
    const res = await POST(new Request('http://x/api/tick', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ durationMs: 1 });
    expect(runTick).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/web vitest run src/app/api/tick/route.test.ts`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Implement** — `apps/web/src/app/api/tick/route.ts`:

```typescript
import pino from 'pino';

import { env } from '@/lib/env';
import { verifyCloudSchedulerOidc } from '@/server/tick/oidc';
import { runTick } from '@/server/tick/tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cloud Scheduler's cron target (consolidation spec §B) — the merged home of
 * forge-tick's POST /tick. OIDC-verified, then one full runTick() pass.
 */
export async function POST(request: Request) {
  const log = pino({ level: env.LOG_LEVEL });
  try {
    await verifyCloudSchedulerOidc(request.headers.get('authorization') ?? undefined);
  } catch (err) {
    log.warn({ err: String(err) }, 'oidc verification failed');
    return Response.json({ error: 'oidc verification failed' }, { status: 401 });
  }

  const result = await runTick(log);
  log.info({ result }, 'tick:done');
  return Response.json(result);
}
```

- [ ] **Step 4: Run tests** — route test PASS, then workspace `pnpm typecheck && pnpm test` green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/tick
git commit -m "feat(web): OIDC-verified POST /api/tick route running the tick pass in-process"
```

### Task 5: Stream route in-process + manual tick direct call

**Files:**
- Modify: `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts` (full rewrite below)
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts:284-300` (`triggerManualTick`)
- Modify: `apps/web/src/lib/env.ts` (delete `TICK_INTERNAL_URL` getter)
- Test: `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.test.ts` (new)

**Interfaces:**
- Consumes: `runTick` (Task 3), `env.ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` (Task 2). `withAuth()` from `@/lib/with-auth` (existing).
- Produces: same external SSE contract as today (200 stream; 503 retryable when task missing/no session; 502 upstream failure).

- [ ] **Step 1: Write the failing test** — `route.test.ts` next to the route. Real-DB pattern (mirrors `src/server/tick/budgets.integration.test.ts`); `withAuth` mocked to a no-op; `global.fetch` stubbed:

```typescript
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_FILE = `/tmp/forge-stream-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

vi.mock('@/lib/with-auth', () => ({ withAuth: vi.fn(async () => ({ user: { id: 'u1' } })) }));

let GET: typeof import('./route').GET;
let client: { close: () => void };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  client = dbMod.client as unknown as { close: () => void };
  // Route dir is 9 levels below repo root:
  // stream → [taskId] → tasks → api → (app) → app → src → web → apps → root.
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  const schema = await import('@forge/db');
  const now = new Date();
  await dbMod.db.insert(schema.missions).values({
    id: 'm1', userId: 'u1', name: 'm', goal: 'g', status: 'running',
    backend: 'managed-agents', agentId: 'a1', plannerStrategy: 'triage',
    webhookSecret: 's', createdAt: now, updatedAt: now,
  });
  await dbMod.db.insert(schema.tasks).values({
    id: 'tsk_nosession', missionId: 'm1', repo: 'a/b', baseBranch: 'main',
    kind: 'fix', status: 'queued', createdAt: now, updatedAt: now,
  });
  await dbMod.db.insert(schema.tasks).values({
    id: 'tsk_live', missionId: 'm1', repo: 'a/b', baseBranch: 'main',
    kind: 'fix', status: 'running', sessionId: 'sess_1', createdAt: now, updatedAt: now,
  });
  ({ GET } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

function params(taskId: string) {
  return { params: Promise.resolve({ taskId }) };
}

describe('GET /api/tasks/[taskId]/stream (in-process)', () => {
  it('503s (retryable) for an unknown task', async () => {
    const res = await GET(new Request('http://x'), params('tsk_missing'));
    expect(res.status).toBe(503);
  });

  it('503s (retryable) for a task with no session yet', async () => {
    const res = await GET(new Request('http://x'), params('tsk_nosession'));
    expect(res.status).toBe(503);
  });

  it('relays the engine stream with the managed-agents beta header', async () => {
    const upstream = new Response(new ReadableStream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstream);
    const res = await GET(new Request('http://x'), params('tsk_live'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v1/sessions/sess_1/events/stream');
    expect((init?.headers as Record<string, string>)['anthropic-beta']).toBe(
      'managed-agents-2026-04-01',
    );
    fetchSpy.mockRestore();
  });

  it('502s when the upstream fetch rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'));
    const res = await GET(new Request('http://x'), params('tsk_live'));
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/web vitest run 'src/app/(app)/api/tasks/[taskId]/stream/route.test.ts'`
Expected: FAIL — current route fetches `TICK_INTERNAL_URL` (connection refused → its catch returns 502, not the expected 503s/relay).

- [ ] **Step 3: Rewrite the route** — full new content of `route.ts`:

```typescript
import { eq } from 'drizzle-orm';

import { tasks } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md),
 * consolidated (2026-07-19 spec §B): the old web→tick→Anthropic proxy chain is
 * now a single in-process hop — DB lookup, then a raw fetch to the Managed
 * Agents engine's session event stream. withAuth() is retained: this route is
 * browser-facing and fronts a raw x-api-key call.
 *
 * Task-missing and no-session-yet both map to 503 (not 404): EventSource does
 * not auto-retry non-5xx, and the browser only asks about real task ids — a
 * 404 would strand the client forever even once dispatch creates a session.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  await withAuth();
  const { taskId } = await params;

  const streamUnavailable = (status: number) =>
    new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task || !task.sessionId) return streamUnavailable(503);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${env.ANTHROPIC_BASE_URL}/v1/sessions/${task.sessionId}/events/stream`,
      {
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
      },
    );
  } catch {
    return streamUnavailable(502);
  }

  if (!upstream.ok || !upstream.body) {
    return streamUnavailable(upstream.status || 502);
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes** — same command as Step 2 → PASS.

- [ ] **Step 5: Manual tick becomes a direct call** — in `actions.ts`, replace `triggerManualTick` in full (its `withAuth()` guard is unchanged; only the transport changes):

```typescript
/** Trigger a tick right now instead of waiting for the next scheduled one. */
export async function triggerManualTick(): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();
  try {
    const pino = (await import('pino')).default;
    const { runTick } = await import('@/server/tick/tick');
    await runTick(pino({ level: env.LOG_LEVEL }));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Tick failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
```

- [ ] **Step 6: Delete the `TICK_INTERNAL_URL` getter from `apps/web/src/lib/env.ts`**, then verify no references remain:

```bash
grep -rn "TICK_INTERNAL_URL" apps/web/src && echo LEFTOVERS || echo CLEAN
```

Expected: `CLEAN`.

- [ ] **Step 7: Workspace green** — `pnpm typecheck && pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add 'apps/web/src/app/(app)/api/tasks/[taskId]/stream' 'apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts' apps/web/src/lib/env.ts
git commit -m "feat(web): stream route and manual tick run in-process; drop TICK_INTERNAL_URL"
```

### Task 6: instrumentation.ts for syncSkillsToDb

**Files:**
- Create: `apps/web/src/instrumentation.ts`
- Test: `apps/web/src/instrumentation.test.ts`

**Interfaces:**
- Consumes: `syncSkillsToDb` (Task 3).
- Produces: Next runs `register()` once per server boot (Node runtime), preserving `apps/tick/src/index.ts:17`'s once-per-boot, non-fatal semantics.

- [ ] **Step 1: Write the failing test** — `apps/web/src/instrumentation.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncSkillsToDb = vi.fn(async () => ({ inserted: 1, updated: 2 }));
vi.mock('@/server/tick/skill-loader', () => ({ syncSkillsToDb }));

import { register } from './instrumentation';

describe('instrumentation register()', () => {
  beforeEach(() => syncSkillsToDb.mockClear());

  it('syncs skills on nodejs runtime boot', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await register();
    expect(syncSkillsToDb).toHaveBeenCalledOnce();
  });

  it('skips non-node runtimes', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    expect(syncSkillsToDb).not.toHaveBeenCalled();
  });

  it('is non-fatal when the sync throws', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    syncSkillsToDb.mockRejectedValueOnce(new Error('db down'));
    await expect(register()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL: `./instrumentation` missing.

- [ ] **Step 3: Implement** — `apps/web/src/instrumentation.ts`:

```typescript
/**
 * Once-per-boot startup hook (replaces apps/tick/src/index.ts's startup sync —
 * consolidation spec §A). Non-fatal: a sync failure must not stop the server;
 * the dispatcher resolves built-in triage skills by slug from the synced table.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { syncSkillsToDb } = await import('@/server/tick/skill-loader');
    const { inserted, updated } = await syncSkillsToDb();
    console.log(`[instrumentation] skills synced (inserted=${inserted} updated=${updated})`);
  } catch (err) {
    console.error('[instrumentation] skill sync failed:', err);
  }
}
```

- [ ] **Step 4: Run tests** — instrumentation test PASS; workspace `pnpm typecheck && pnpm test` green; `pnpm --filter @forge/web build` still succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/instrumentation.ts apps/web/src/instrumentation.test.ts
git commit -m "feat(web): sync skills to DB at boot via instrumentation register()"
```

### Task 7: Workflows + Dockerfile packaging

**Files:**
- Modify: `.github/workflows/ci.yml` (delete the `Build forge-tick` step, lines ~52-59)
- Modify: `.github/workflows/deploy.yml` (delete the `Build and push forge-tick` step and the `deploy-cloudrun` step targeting service `forge-tick`, lines ~123-140)
- Modify: `apps/web/Dockerfile` (ship `skills/`)

**Interfaces:**
- Consumes: nothing new. Produces: CI/deploy build only the web image; the web image self-contains the skills library.

- [ ] **Step 1: ci.yml** — delete this step (verify with `git diff` that only it is removed):

```yaml
      - name: Build forge-tick
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/tick/Dockerfile
          push: false
          cache-from: type=gha,scope=tick
          cache-to: type=gha,scope=tick,mode=max
```

- [ ] **Step 2: deploy.yml** — delete the `Build and push forge-tick` step (`file: apps/tick/Dockerfile`, tags `…/tick:…`) and the `google-github-actions/deploy-cloudrun@v2` step with `service: forge-tick`. Keep every web build/deploy step untouched.

- [ ] **Step 3: Dockerfile** — in the `runner` stage of `apps/web/Dockerfile`, after the `public` COPY line, add:

```dockerfile
# Skill library for the in-process tick engine (consolidation spec §C).
COPY --from=builder --chown=nextjs:nodejs /app/skills ./skills
ENV FORGE_SKILLS_DIR=/app/skills
```

- [ ] **Step 4: Validate** — `docker build -f apps/web/Dockerfile .` locally if Docker is available; otherwise ensure `actionlint`/YAML parse passes (`npx yaml-lint` or a CI dry run) and workspace `pnpm typecheck && pnpm test` stay green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml apps/web/Dockerfile
git commit -m "chore(deploy): single web image ships skills/; drop tick build+deploy from workflows"
```

### Task 8: Cutover checklist + delete apps/tick

**Files:**
- Delete: `apps/tick/` (entire directory)
- Modify: `apps/web/src/app/(marketing)/page.tsx:137` (quickstart copy)

**Interfaces:** none — this is the terminal cleanup.

- [ ] **Step 1: OPERATOR CUTOVER (manual, outside this repo — do not proceed past this step until confirmed):**
  1. Deploy the merged apps/web image to its Cloud Run service (Task 7's pipeline).
  2. Repoint the Cloud Scheduler job's target URL to `<web-service-url>/api/tick` (OIDC audience = the web service URL; set `TICK_EXPECTED_AUDIENCE` accordingly on the web service).
  3. Confirm one full `/tick` pass succeeds against production data via logs/DB state — subsystem counters in the `tick:done` log line, not just a 200.
  4. Confirm the boot log line `[instrumentation] skills synced (…)`.

- [ ] **Step 2: Delete apps/tick and fix the quickstart copy**

```bash
git rm -r apps/tick
```

In `apps/web/src/app/(marketing)/page.tsx`, delete the line `cp apps/tick/.env.example apps/tick/.env.local` from the `quickstart` template string.

- [ ] **Step 3: Verify no references remain**

```bash
grep -rn "apps/tick\|forge-tick\|TICK_INTERNAL_URL" --include='*.{ts,tsx,yml,yaml,json,md,mjs}' . | grep -v docs/superpowers | grep -v node_modules && echo LEFTOVERS || echo CLEAN
```

Expected: `CLEAN` (design docs are allowed to keep historical references).

- [ ] **Step 4: Workspace green** — `pnpm install` (lockfile drops @forge/tick), `pnpm typecheck && pnpm test && pnpm --filter @forge/web build`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: retire apps/tick — engine now lives in apps/web (consolidation spec)"
```
