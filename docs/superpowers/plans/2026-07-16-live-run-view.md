# Live Run View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static, page-load-time task views with a live-streaming run view — a proxy chain from the Managed Agents engine through tick and web to the browser — plus synthesized file tabs on the Task detail page and a new condensed run panel in the Repo Workspace.

**Architecture:** Two thin SSE proxy hops (tick → web → browser), a shared pure log-line formatter used identically for static (DB-persisted) and live (streamed) events, one shared React log-view component consumed by both a new `IssueRunPanel` (Repo Workspace) and the existing Task detail page. `IssueTriageCard` (used in the list context on `/missions/[id]/issues`) is left untouched — see Global Constraints for why.

**Tech Stack:** Fastify (tick), Next.js App Router route handlers + Server-Sent Events (web), React 19 client components, `EventSource`, vitest.

## Global Constraints

- No literal sandbox-filesystem access exists or is added — file tabs are synthesized from `task.promptVars`, the event ledger, and `task.verdict`/`task.status`, and must read/present as Forge data, not fabricated sandbox contents.
- **Do not modify `IssueTriageCard`** (`apps/web/src/components/issue-triage-card.tsx`). It's rendered in a loop on `/missions/[id]/issues` (potentially many at once) — opening a live `EventSource` per card there would mean many concurrent streaming connections for a page that only needs a snapshot. The new live/tabbed view (`IssueRunPanel`) is a separate component used only where exactly one issue is focused at a time (the Repo Workspace detail pane).
- The persisted Ledger and the cron-scheduled `/tick` reconciliation loop are unchanged. The streaming proxy is a parallel, on-demand, ephemeral read path — it never writes to the DB.
- Credentials stay exactly where they are today: only `apps/tick` holds `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`FORGE_MA_ENVIRONMENT_ID`. `apps/web` never receives them — it only ever talks to tick's own proxy endpoint.
- The engine's SSE beta headers are exact strings, copy verbatim: `anthropic-version: 2023-06-01`, `anthropic-beta: managed-agents-2026-04-01`.
- An `EventSource` connection is opened by the browser only when the relevant task's status is `running` (or earlier/dispatching); once terminal, views render from already-persisted `ledgerEvents` with no connection attempt.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.
- Spec: `docs/superpowers/specs/2026-07-16-live-run-view-design.md`.

---

### Task 1: Shared log-line formatter (pure, TDD)

**Files:**
- Create: `apps/web/src/lib/session-log-format.ts`
- Test: `apps/web/src/lib/session-log-format.test.ts`

**Interfaces:**
- Produces:
  - `type LogEventLike = { eventType: string; payload: unknown }`
  - `formatLogLine(event: LogEventLike): string`
  - `isToolEvent(event: LogEventLike): boolean`
  - `normalizeRawSessionEvent(raw: unknown): { id: string; eventType: string; payload: unknown; createdAt: Date }`
- This file has no DB/server imports — pure, browser-safe (imported by both a server component and a client component in later tasks).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/session-log-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { formatLogLine, isToolEvent, normalizeRawSessionEvent } from './session-log-format';

describe('formatLogLine', () => {
  it('formats agent.message from its text content block', () => {
    const line = formatLogLine({
      eventType: 'agent.message',
      payload: { content: [{ type: 'text', text: 'Hello from the agent' }] },
    });
    expect(line).toBe('[assistant] Hello from the agent');
  });

  it('truncates long agent.message text to 300 chars with an ellipsis', () => {
    const longText = 'a'.repeat(400);
    const line = formatLogLine({
      eventType: 'agent.message',
      payload: { content: [{ type: 'text', text: longText }] },
    });
    expect(line).toBe(`[assistant] ${'a'.repeat(300)}…`);
  });

  it('formats agent.thinking as a fixed label (no content in real payloads)', () => {
    const line = formatLogLine({ eventType: 'agent.thinking', payload: { seq: 3 } });
    expect(line).toBe('[thinking…]');
  });

  it('formats agent.tool_use with the tool name and input.description', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_use',
      payload: {
        name: 'Agent',
        input: { description: 'Explore agentstep/product repo structure' },
      },
    });
    expect(line).toBe('[tool] Agent — Explore agentstep/product repo structure');
  });

  it('formats agent.tool_use with just the name when input has no description', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_use',
      payload: { name: 'Bash', input: { command: 'ls' } },
    });
    expect(line).toBe('[tool] Bash');
  });

  it('formats agent.tool_result with exit code and stdout', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_result',
      payload: {
        content: { exitCode: 0, stdout: '(Bash completed with no output)' },
        is_error: false,
      },
    });
    expect(line).toBe('[tool result] exit 0 — (Bash completed with no output)');
  });

  it('formats agent.tool_result as an error when is_error is true and no exit code', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_result',
      payload: { content: {}, is_error: true },
    });
    expect(line).toBe('[tool result] error');
  });

  it('formats session.error from error.message', () => {
    const line = formatLogLine({
      eventType: 'session.error',
      payload: { error: { type: 'server_error', message: 'container creation failed' } },
    });
    expect(line).toBe('[error] container creation failed');
  });

  it('formats session.status_* events', () => {
    expect(formatLogLine({ eventType: 'session.status_running', payload: {} })).toBe(
      '[session] running',
    );
    expect(formatLogLine({ eventType: 'session.status_idle', payload: {} })).toBe(
      '[session] idle',
    );
  });

  it('formats user.message from its text content block', () => {
    const line = formatLogLine({
      eventType: 'user.message',
      payload: { content: [{ type: 'text', text: 'Triage open issues in acme/api' }] },
    });
    expect(line).toBe('[user] Triage open issues in acme/api');
  });

  it('falls back to a generic [forge] line for Forge-synthetic event types', () => {
    expect(
      formatLogLine({ eventType: 'dispatcher.dispatched', payload: { sessionId: 'sesn_1' } }),
    ).toBe('[forge] dispatcher.dispatched');
    expect(formatLogLine({ eventType: 'workspace.issue.enqueued', payload: {} })).toBe(
      '[forge] workspace.issue.enqueued',
    );
  });

  it('handles missing/malformed payload fields without throwing', () => {
    expect(() => formatLogLine({ eventType: 'agent.message', payload: null })).not.toThrow();
    expect(() => formatLogLine({ eventType: 'agent.tool_use', payload: {} })).not.toThrow();
    expect(formatLogLine({ eventType: 'agent.message', payload: null })).toBe('[assistant] ');
  });
});

describe('isToolEvent', () => {
  it('is true for agent.tool_use and agent.tool_result', () => {
    expect(isToolEvent({ eventType: 'agent.tool_use', payload: {} })).toBe(true);
    expect(isToolEvent({ eventType: 'agent.tool_result', payload: {} })).toBe(true);
  });

  it('is false for other event types', () => {
    expect(isToolEvent({ eventType: 'agent.message', payload: {} })).toBe(false);
    expect(isToolEvent({ eventType: 'dispatcher.dispatched', payload: {} })).toBe(false);
  });
});

describe('normalizeRawSessionEvent', () => {
  it('maps a raw engine SSE event into the LedgerEvent-like shape', () => {
    const raw = {
      id: 'sevt_abc123',
      type: 'agent.message',
      processed_at: '2026-07-16T10:00:00.000Z',
      content: [{ type: 'text', text: 'hi' }],
      seq: 5,
    };
    const normalized = normalizeRawSessionEvent(raw);
    expect(normalized.id).toBe('sevt_abc123');
    expect(normalized.eventType).toBe('agent.message');
    expect(normalized.payload).toBe(raw);
    expect(normalized.createdAt).toEqual(new Date('2026-07-16T10:00:00.000Z'));
  });

  it('falls back to a generated id and the current time when fields are missing', () => {
    const normalized = normalizeRawSessionEvent({});
    expect(normalized.id).toMatch(/^live_/);
    expect(normalized.eventType).toBe('unknown');
    expect(normalized.createdAt).toBeInstanceOf(Date);
  });

  it('handles a non-object input without throwing', () => {
    expect(() => normalizeRawSessionEvent(null)).not.toThrow();
    expect(() => normalizeRawSessionEvent('not an object')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- session-log-format`
Expected: FAIL — cannot resolve `./session-log-format`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/session-log-format.ts`:

```ts
/**
 * Renders both persisted Ledger events and live-streamed raw session events
 * as human-readable lines, using one formatter for both — a live event is
 * normalized into the same {eventType, payload} shape a persisted
 * LedgerEvent already has (backend-sourced ledger rows store the raw engine
 * event verbatim as `payload`), so this file never needs to know which
 * source an event came from.
 */

export type LogEventLike = {
  eventType: string;
  payload: unknown;
};

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function firstText(payload: unknown): string {
  const content = asRecord(payload).content;
  if (Array.isArray(content)) {
    const block = content.find(
      (c): c is { type: string; text?: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
    );
    if (block && typeof block.text === 'string') return block.text;
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function formatLogLine(event: LogEventLike): string {
  const p = asRecord(event.payload);

  switch (event.eventType) {
    case 'agent.message':
      return `[assistant] ${truncate(firstText(event.payload), 300)}`;

    case 'agent.thinking':
      return '[thinking…]';

    case 'agent.tool_use': {
      const name = typeof p.name === 'string' ? p.name : 'tool';
      const input = asRecord(p.input);
      const description = typeof input.description === 'string' ? input.description : undefined;
      return description ? `[tool] ${name} — ${truncate(description, 120)}` : `[tool] ${name}`;
    }

    case 'agent.tool_result': {
      const content = asRecord(p.content);
      const exitCode = content.exitCode;
      const stdout = typeof content.stdout === 'string' ? content.stdout : undefined;
      if (typeof exitCode === 'number') {
        return stdout
          ? `[tool result] exit ${exitCode} — ${truncate(stdout, 120)}`
          : `[tool result] exit ${exitCode}`;
      }
      return p.is_error === true ? '[tool result] error' : '[tool result] ok';
    }

    case 'session.error': {
      const error = asRecord(p.error);
      const message = typeof error.message === 'string' ? error.message : 'unknown error';
      return `[error] ${message}`;
    }

    case 'session.status_running':
    case 'session.status_idle':
    case 'session.status_terminated':
      return `[session] ${event.eventType.replace('session.status_', '')}`;

    case 'user.message':
      return `[user] ${truncate(firstText(event.payload), 200)}`;

    default:
      return `[forge] ${event.eventType}`;
  }
}

export function isToolEvent(event: LogEventLike): boolean {
  return event.eventType === 'agent.tool_use' || event.eventType === 'agent.tool_result';
}

/**
 * Maps a raw engine SSE frame (the `data:` JSON of an /events/stream event —
 * shape: `{ id, type, seq, processed_at, ... }`) into the same
 * {id, eventType, payload, createdAt} shape a persisted LedgerEvent has, so
 * the rest of the app (formatLogLine, isToolEvent, list rendering) never
 * needs a separate code path for live vs. static events.
 */
export function normalizeRawSessionEvent(raw: unknown): {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
} {
  const r = asRecord(raw);
  const id = typeof r.id === 'string' ? r.id : `live_${Math.random().toString(36).slice(2)}`;
  const eventType = typeof r.type === 'string' ? r.type : 'unknown';
  const createdAt = typeof r.processed_at === 'string' ? new Date(r.processed_at) : new Date();
  return { id, eventType, payload: raw, createdAt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- session-log-format`
Expected: PASS (16 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/session-log-format.ts apps/web/src/lib/session-log-format.test.ts
git commit -m "feat(live-run): shared log-line formatter for static and live events"
```

---

### Task 2: Tick — `GET /tasks/:taskId/stream` SSE proxy

**Files:**
- Modify: `apps/tick/src/env.ts` (add `ANTHROPIC_BASE_URL`)
- Modify: `apps/tick/src/server.ts` (add the route)
- Test: `apps/tick/src/server.test.ts` (create — check first whether it exists: `ls apps/tick/src/server.test.ts`)

**Interfaces:**
- Produces: `GET /tasks/:taskId/stream` — 404 if the task doesn't exist or has no `sessionId` yet; otherwise proxies `GET {ANTHROPIC_BASE_URL}/v1/sessions/{sessionId}/events/stream` as a raw byte passthrough with `content-type: text/event-stream`.

- [ ] **Step 1: Add `ANTHROPIC_BASE_URL` to tick's env**

In `apps/tick/src/env.ts`, add one line right after `ANTHROPIC_API_KEY`:

```ts
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  // Only read directly by the /tasks/:taskId/stream proxy (Task 2 of the
  // live-run-view plan) — the Anthropic SDK client itself already falls
  // back to this same env var internally when unset.
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  FORGE_MA_ENVIRONMENT_ID: process.env.FORGE_MA_ENVIRONMENT_ID,
```

- [ ] **Step 2: Check for an existing server test file and its patterns**

Run: `ls apps/tick/src/server.test.ts 2>&1`. If it exists, read it and match its `buildServer()`/`app.inject()` setup exactly. If it doesn't exist, this task creates it fresh — Fastify's `app.inject({ method, url })` is the standard way to test routes without binding a real port; no other tick test file uses this pattern yet, so there's nothing else to match beyond the DB-seeding conventions already established in `reconciler.test.ts`/`reconciler.integration.test.ts` (real libSQL file, `beforeAll`/`afterAll` migrate+cleanup) for seeding a task row.

- [ ] **Step 3: Add the route**

In `apps/tick/src/server.ts`, add imports and the new route. Full resulting file:

```ts
import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { eq } from 'drizzle-orm';

import { tasks } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { verifyCloudSchedulerOidc } from './oidc';
import { runTick } from './tick';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    disableRequestLogging: false,
  });

  await app.register(sensible);

  app.get('/healthz', async () => ({ status: 'ok', service: 'forge-tick' }));

  app.post('/tick', async (request, reply) => {
    try {
      await verifyCloudSchedulerOidc(request.headers.authorization);
    } catch (err) {
      request.log.warn({ err }, 'oidc verification failed');
      return reply.unauthorized('oidc verification failed');
    }

    const result = await runTick(request.log);
    request.log.info({ result }, 'tick:done');
    return reply.send(result);
  });

  // Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md).
  // Proxies the Managed Agents engine's real session event stream through to
  // the caller (apps/web's own SSE route) as a raw passthrough — no
  // transformation, no persistence. Separate code path from the cron-driven
  // /tick handler above; only active while something is connected.
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/stream', async (request, reply) => {
    const { taskId } = request.params;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return reply.notFound(`no task ${taskId}`);
    if (!task.sessionId) return reply.notFound(`task ${taskId} has no session yet`);

    const upstream = await fetch(
      `${env.ANTHROPIC_BASE_URL}/v1/sessions/${task.sessionId}/events/stream`,
      {
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
      },
    );

    if (!upstream.ok || !upstream.body) {
      return reply.code(upstream.status || 502).send({ error: 'upstream stream unavailable' });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const nodeStream = Readable.fromWeb(upstream.body as never);
    nodeStream.pipe(reply.raw);
    request.raw.on('close', () => nodeStream.destroy());

    return reply;
  });

  return app;
}
```

- [ ] **Step 4: Write tests**

Create `apps/tick/src/server.test.ts` (following `reconciler.integration.test.ts`'s real-libSQL-file setup pattern — read that file first for its exact `beforeAll`/migrate/`afterAll` boilerplate and mirror it here):

```ts
import { unlinkSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DB_PATH = `/tmp/forge-server-test-${process.pid}.db`;

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'; // unreachable — exercised only for the 404 paths below
  const { migrate } = await import('./migrate-test-helper');
  await migrate();
});

afterAll(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // already gone
  }
});

describe('GET /tasks/:taskId/stream', () => {
  it('404s for an unknown task', async () => {
    const { buildServer } = await import('./server');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/tasks/tsk_does_not_exist/stream' });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a task with no sessionId yet', async () => {
    const { db } = await import('./db');
    const { tasks, missions } = await import('@forge/db');
    const now = new Date();
    await db.insert(missions).values({
      id: 'msn_stream_test',
      userId: 'usr_1',
      name: 'test',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tasks).values({
      id: 'tsk_no_session',
      missionId: 'msn_stream_test',
      repo: 'acme/api',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const { buildServer } = await import('./server');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/tasks/tsk_no_session/stream' });
    expect(res.statusCode).toBe(404);
  });
});
```

If `./migrate-test-helper` doesn't exist as a shared helper in this package, check `reconciler.integration.test.ts` for however it runs migrations against its own test DB file and inline that same approach directly in this file's `beforeAll` instead of importing a helper that isn't there — don't invent a shared helper module speculatively; only extract one if the exact same boilerplate already exists verbatim in another test file and you're just reusing it.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @forge/tick test -- server`
Expected: both tests pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @forge/tick typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/tick/src/env.ts apps/tick/src/server.ts apps/tick/src/server.test.ts
git commit -m "feat(live-run): tick SSE proxy for session event streams"
```

---

### Task 3: Web — `GET /api/tasks/[taskId]/stream` SSE proxy

**Files:**
- Modify: `apps/web/src/lib/env.ts` (add `TICK_INTERNAL_URL`)
- Create: `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts`

**Interfaces:**
- Consumes: tick's `GET /tasks/:taskId/stream` (Task 2), `withAuth` (`@/lib/with-auth`).
- Produces: `GET /api/tasks/[taskId]/stream` — authenticated; proxies tick's stream through as the browser-facing SSE response.

- [ ] **Step 1: Add `TICK_INTERNAL_URL` to web's env**

In `apps/web/src/lib/env.ts`, add near the other cross-service config (find a sensible spot — after `FORGE_BACKEND` or near other URL-shaped getters):

```ts
  get TICK_INTERNAL_URL(): string {
    return optional('TICK_INTERNAL_URL') ?? 'http://localhost:8180';
  },
```

- [ ] **Step 2: Write the route**

Create `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts`:

```ts
import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md).
 * Browser-facing half of the streaming proxy chain: authenticates the
 * request, then relays tick's own /tasks/:taskId/stream through as SSE. Tick
 * holds all Managed Agents credentials — this route never sees them.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  await withAuth();
  const { taskId } = await params;

  const upstream = await fetch(`${env.TICK_INTERNAL_URL}/tasks/${taskId}/stream`);

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'stream unavailable' }), {
      status: upstream.status || 502,
      headers: { 'content-type': 'application/json' },
    });
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

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/api/tasks/tsk_nonexistent/stream`
Expected: `307` (auth redirect — `withAuth()` runs before the fetch to tick).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/env.ts "apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts"
git commit -m "feat(live-run): web SSE proxy route for task streams"
```

---

### Task 4: `SessionLogView` shared client component

**Files:**
- Create: `apps/web/src/components/session-log-view.tsx`

**Interfaces:**
- Consumes: `formatLogLine`, `normalizeRawSessionEvent`, `type LogEventLike` (Task 1, `@/lib/session-log-format`).
- Produces:
  ```tsx
  <SessionLogView
    taskId={string}
    isLive={boolean}          // true only when the task's status is running/dispatching
    initialEvents={Array<{ id: string; eventType: string; payload: unknown; createdAt: Date | string }>}
    maxLines?: number         // when set, renders only the last N lines (condensed mode); omitted = unbounded (full mode)
    className?: string
  />
  ```
  When `isLive` is true, opens `new EventSource('/api/tasks/{taskId}/stream')` on mount, normalizes each incoming message via `normalizeRawSessionEvent`, and appends to the rendered list; closes the connection on unmount or when `isLive` flips to false. When `isLive` is false, renders only `initialEvents` (already in chronological order — callers are responsible for ordering, see Tasks 5/6).

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/session-log-view.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

import { formatLogLine, normalizeRawSessionEvent, type LogEventLike } from '@/lib/session-log-format';

type LogEvent = LogEventLike & { id: string; createdAt: Date | string };

export function SessionLogView({
  taskId,
  isLive,
  initialEvents,
  maxLines,
  className,
}: {
  taskId: string;
  isLive: boolean;
  initialEvents: LogEvent[];
  maxLines?: number;
  className?: string;
}) {
  const [events, setEvents] = useState<LogEvent[]>(initialEvents);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents(initialEvents);
    // Only re-seed when the task changes — live events accumulate on top
    // independently, and initialEvents is a snapshot taken once per render
    // of the parent, not a dependency we want to re-trigger on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (!isLive) return;
    const source = new EventSource(`/api/tasks/${taskId}/stream`);
    source.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as unknown;
        const normalized = normalizeRawSessionEvent(parsed);
        setEvents((prev) => [...prev, normalized]);
      } catch {
        // Malformed frame (e.g. a keepalive comment surfaced as a message in
        // some browsers) — drop it rather than crash the view.
      }
    };
    return () => source.close();
  }, [taskId, isLive]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const visible = typeof maxLines === 'number' ? events.slice(-maxLines) : events;

  return (
    <div
      ref={containerRef}
      className={`overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed ${className ?? ''}`}
    >
      {visible.length === 0 ? (
        <p className="text-muted-foreground">No activity yet.</p>
      ) : (
        visible.map((event) => (
          <div key={event.id} className="whitespace-pre-wrap break-words">
            {formatLogLine(event)}
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. (`EventSource` is a browser global; this file has `'use client'` so it never executes server-side — if `tsc` complains about the `EventSource` type not being found, check `apps/web/tsconfig.json`'s `lib` array includes `"DOM"`, which it already must since other client components in this codebase use browser APIs.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/session-log-view.tsx
git commit -m "feat(live-run): shared SessionLogView component (static + live modes)"
```

---

### Task 5: `IssueRunPanel` — new component for the Repo Workspace detail pane

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`

**Interfaces:**
- Consumes: `type IssueGroup` (`@/lib/triage-view`), `SessionLogView` (Task 4), `listLedgerForTask` (`@/lib/ledger`) — but see Step 1: this is a client component, so ledger fetching must happen in the parent server component and be passed down as a prop, not fetched here directly.
- Produces:
  ```tsx
  <IssueRunPanel
    group={IssueGroup}
    missionId={string}
    reproduceLedger={Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>}
    fixLedger={Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>}
  />
  ```
  Renders the verdict summary (if present), a Reproduce/Fix tab bar (dot color from the existing `TriageHeadline`/`Badge` variant conventions already used in `IssueTriageCard` — read that file for the exact `HEADLINE` label/variant map and reuse the same values, don't invent new ones), the condensed `SessionLogView` (`maxLines={15}`, `className="h-[200px]"`) for whichever tab is selected, and a "View full run →" link to `/missions/{missionId}/tasks/{taskId}`.

- [ ] **Step 1: Write the component**

Reuse `TaskStatusBadge` (`apps/web/src/components/task-status-badge.tsx`, already used on the Task detail page) for the per-stage status dot — it already maps every real `TaskStatus` value to the correct color; do not invent a separate status→color mapping.

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';

import { SessionLogView } from '@/components/session-log-view';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { IssueGroup } from '@/lib/triage-view';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

const RUNNING_STATUSES = new Set(['queued', 'dispatching', 'running']);

export function IssueRunPanel({
  group,
  missionId,
  reproduceLedger,
  fixLedger,
}: {
  group: IssueGroup;
  missionId: string;
  reproduceLedger: LedgerRow[];
  fixLedger: LedgerRow[];
}) {
  const [stage, setStage] = useState<'reproduce' | 'fix'>(
    group.fix ? 'fix' : 'reproduce',
  );

  const task = stage === 'reproduce' ? group.reproduce : group.fix;
  const ledger = stage === 'reproduce' ? reproduceLedger : fixLedger;
  const isLive = task ? RUNNING_STATUSES.has(task.status) : false;
  const verdict = group.reproduce?.verdict ?? null;

  return (
    <div className="space-y-3">
      {verdict?.summary ? (
        <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          {verdict.summary}
        </p>
      ) : null}

      <div className="flex gap-1 border-b">
        {(['reproduce', 'fix'] as const).map((key) => {
          const t = key === 'reproduce' ? group.reproduce : group.fix;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setStage(key)}
              className={`px-3 py-1.5 text-xs font-medium capitalize ${
                stage === key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {key}
              {t ? (
                <span className="ml-1.5 inline-block align-middle">
                  <TaskStatusBadge status={t.status} haltReason={t.haltReason} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {task ? (
        <>
          <SessionLogView
            taskId={task.id}
            isLive={isLive}
            initialEvents={ledger}
            maxLines={15}
            className="h-[200px]"
          />
          <Link
            href={`/missions/${missionId}/tasks/${task.id}`}
            className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View full run →
          </Link>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This stage hasn&apos;t started.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. (If `IssueGroup`'s `reproduce`/`fix` fields don't carry a `verdict` field directly on the `Task` type in the shape assumed above, check `packages/db/src/schema.ts`'s `tasks` table — `verdict` is a real column per `Task = typeof tasks.$inferSelect`, so `group.reproduce?.verdict` should type-check as `ReproduceVerdict | null | undefined` already.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx"
git commit -m "feat(live-run): IssueRunPanel with Reproduce/Fix tabs and condensed live log"
```

---

### Task 6: Wire `IssueRunPanel` into the Repo Workspace

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`

**Interfaces:**
- Consumes: `IssueRunPanel` (Task 5), `listLedgerForTask` (`@/lib/ledger`, existing).
- Produces: the workspace page now fetches each visible issue's reproduce/fix task ledgers server-side and passes them down; `workspace-list.tsx` renders `IssueRunPanel` instead of `IssueTriageCard` for the selected row.

- [ ] **Step 1: Fetch ledgers in the page (server component)**

Read the current `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx` in full first (it already fetches `tasks` via `listTasksForMission` and builds `rows` via `mergeIssuesWithGroups`). Add, right after `rows` is built:

```ts
  const ledgersByTaskId = new Map<string, Awaited<ReturnType<typeof listLedgerForTask>>>();
  await Promise.all(
    rows.flatMap((row) => {
      const ids = [row.group?.reproduce?.id, row.group?.fix?.id].filter(
        (id): id is string => !!id,
      );
      return ids.map(async (id) => {
        ledgersByTaskId.set(id, await listLedgerForTask(id, 200));
      });
    }),
  );
```

Add the import: `import { listLedgerForTask } from '@/lib/ledger';`

Pass `ledgersByTaskId` (serialized-friendly: convert the `Map` to a plain object keyed by task id before passing to the client component, since `Map` isn't a valid Server→Client Component prop) to `WorkspaceList`:

```ts
  const ledgersByTaskId = Object.fromEntries(ledgersByTaskIdMap);
```

(rename the `Map` variable to `ledgersByTaskIdMap` in the snippet above to avoid shadowing).

- [ ] **Step 2: Accept and use the ledgers in `WorkspaceList`, rendering `IssueRunPanel`**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`:
- Add `ledgersByTaskId: Record<string, Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>>` to the component's props type.
- Replace the import `import { IssueTriageCard } from '@/components/issue-triage-card';` with `import { IssueRunPanel } from './issue-run-panel';`.
- Replace the block:
  ```tsx
  {selected.group && missionId ? (
    <IssueTriageCard group={selected.group} missionId={missionId} />
  ) : (
  ```
  with:
  ```tsx
  {selected.group && missionId ? (
    <IssueRunPanel
      group={selected.group}
      missionId={missionId}
      reproduceLedger={
        selected.group.reproduce ? (ledgersByTaskId[selected.group.reproduce.id] ?? []) : []
      }
      fixLedger={selected.group.fix ? (ledgersByTaskId[selected.group.fix.id] ?? []) : []}
    />
  ) : (
  ```
- Thread `ledgersByTaskId` through wherever `WorkspaceList` is invoked from `page.tsx`.

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/acme/api`
Expected: `307`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx"
git commit -m "feat(live-run): wire IssueRunPanel into the repo workspace detail pane"
```

---

### Task 7: Synthesized file tabs on the Task detail page

**Files:**
- Create: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/file-tabs.tsx`

**Interfaces:**
- Consumes: `formatLogLine`, `isToolEvent` (`@/lib/session-log-format`), `type LedgerEvent` (`@forge/db`).
- Produces:
  ```tsx
  <TaskFileTabs
    promptVars={Record<string, unknown> | null}
    status={string}
    verdict={ReproduceVerdict | null}
    ledger={LedgerEvent[]}   // already fetched by the page, newest-first
  />
  ```
  Renders a small tab bar: `prompt.txt` (pretty-printed `promptVars`), `agent.log` (every ledger event, chronological, via `formatLogLine`), `console.log` (same, filtered to `isToolEvent`; **tab is omitted entirely if no ledger event satisfies `isToolEvent`** — don't render an empty tab), `status.json` (pretty-printed `{status, verdict}`).

- [ ] **Step 1: Write the component**

Create `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/file-tabs.tsx`:

```tsx
'use client';

import { useMemo, useState } from 'react';

import { formatLogLine, isToolEvent } from '@/lib/session-log-format';
import type { LedgerEvent, ReproduceVerdict } from '@forge/db';

type FileTab = 'prompt.txt' | 'agent.log' | 'console.log' | 'status.json';

export function TaskFileTabs({
  promptVars,
  status,
  verdict,
  ledger,
}: {
  promptVars: Record<string, unknown> | null;
  status: string;
  verdict: ReproduceVerdict | null;
  ledger: LedgerEvent[];
}) {
  const chronological = useMemo(() => [...ledger].reverse(), [ledger]);
  const hasToolEvents = useMemo(() => chronological.some(isToolEvent), [chronological]);

  const tabs: FileTab[] = [
    'prompt.txt',
    'agent.log',
    ...(hasToolEvents ? (['console.log'] as const) : []),
    'status.json',
  ];
  const [active, setActive] = useState<FileTab>('agent.log');

  const content = (() => {
    switch (active) {
      case 'prompt.txt':
        return JSON.stringify(promptVars ?? {}, null, 2);
      case 'agent.log':
        return chronological.map((e) => formatLogLine(e)).join('\n') || 'No activity yet.';
      case 'console.log':
        return (
          chronological.filter(isToolEvent).map((e) => formatLogLine(e)).join('\n') ||
          'No tool activity yet.'
        );
      case 'status.json':
        return JSON.stringify({ status, verdict }, null, 2);
    }
  })();

  return (
    <div className="rounded-md border">
      <div className="flex gap-1 border-b bg-muted/30 px-2 pt-2">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActive(tab)}
            className={`rounded-t px-3 py-1.5 font-mono text-xs ${
              active === tab
                ? 'border border-b-0 bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <pre className="max-h-[400px] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {content}
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/file-tabs.tsx"
git commit -m "feat(live-run): synthesized file tabs (prompt/agent.log/console.log/status)"
```

---

### Task 8: Wire file tabs + full live log into the Task detail page

**Files:**
- Modify: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `TaskFileTabs` (Task 7), `SessionLogView` (Task 4).
- Produces: the page renders `TaskFileTabs` + a full-height live `SessionLogView` between the existing Task/Timeline cards and the Ledger card. No existing markup is removed.

- [ ] **Step 1: Add the new section**

In `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`, add imports:

```ts
import { SessionLogView } from '@/components/session-log-view';

import { TaskFileTabs } from './file-tabs';
```

Insert this block right after the closing `</div>` of the `grid grid-cols-1 gap-6 md:grid-cols-2` section (i.e., between the Task/Timeline cards grid and the `<Card className="mt-6">` Ledger card):

```tsx
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            prompt.txt, agent.log, and status.json are Forge-captured data presented as
            files — not a view of the actual sandbox filesystem.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TaskFileTabs
            promptVars={task.promptVars as Record<string, unknown> | null}
            status={task.status}
            verdict={task.verdict}
            ledger={ledger}
          />
          <SessionLogView
            taskId={task.id}
            isLive={['queued', 'dispatching', 'running'].includes(task.status)}
            initialEvents={[...ledger].reverse()}
            className="h-[400px]"
          />
        </CardContent>
      </Card>
```

- [ ] **Step 2: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/missions/msn_test/tasks/tsk_test`
Expected: `307` (auth redirect — a 500 means a compile error, check `curl -s ... | head -50` and fix).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx"
git commit -m "feat(live-run): file tabs + full live log on the Task detail page"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web and tick test suites**

Run: `pnpm --filter @forge/web test && pnpm --filter @forge/tick test`
Expected: all suites pass, including the new `session-log-format.test.ts` and `server.test.ts`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification (requires the signed-in operator, tick and web both running, and an active or recently-completed task with real ledger events — e.g. re-dispatch the `agentstep/product#6` reproduce task from earlier this session)**

Ask the operator to confirm:

1. Repo Workspace (`/repos/[owner]/[repo]`): selecting an issue with an in-flight or completed reproduce/fix pair shows the Reproduce/Fix tab bar and a condensed, auto-scrolling log (not the old flat `IssueTriageCard` stage rows).
2. While a task is `running`, the condensed log updates live without a page refresh (open the Task detail page in a second tab to compare timing).
3. "View full run →" navigates to the Task detail page.
4. Task detail page shows the new `prompt.txt`/`agent.log`/`status.json` tabs (and `console.log` when the task had tool calls), plus a full-height live log below them, above the existing (unchanged) Ledger card.
5. Stop tick (kill the dev server) mid-run and confirm both views fall back gracefully to the static ledger content with no visible error, rather than breaking.
6. `/missions/[id]/issues` (the list page) is visually unchanged — confirms `IssueTriageCard` was correctly left untouched.

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
