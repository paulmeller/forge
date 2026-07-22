# Gemini Backend Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GeminiManagedAgentsAdapter`, a third `BackendAdapter` implementation, so a mission can run against Google's Gemini Interactions API instead of Anthropic Managed Agents or the Gateway — without any change to the dispatcher, poller, reconciler, or gates.

**Architecture:** Plain `fetch` against `https://generativelanguage.googleapis.com/v1beta/interactions` (no new npm dependency, mirroring `GatewayAdapter`'s existing "plain HTTP, no SDK" precedent). Since Gemini's protocol returns one polled interaction object with a `steps` array rather than a discrete event stream, the adapter reconstructs a full deterministic list of synthetic `BackendEvent`s on every poll and slices it by `afterEventId` — the same cursor pattern `ManagedAgentsAdapter`/`GatewayAdapter` already use.

**Tech Stack:** TypeScript, Vitest, global `fetch` (Node 18+ built-in, already used elsewhere in this repo via similar adapters), no new dependencies.

## Global Constraints

- No new npm dependency — plain `fetch`, not a Gemini SDK (spec: "Session Creation & Credentials").
- No live Gemini API calls in the committed automated test suite (spec: "Testing"). The one live smoke check in Task 2 is controller-run, not a subagent/CI test.
- `confirmToolUse` throws — v1 attaches no tool that should ever produce a confirmation-required state (spec: "confirmToolUse").
- Only `tools: [{ "type": "code_execution" }]` is attached — never a GitHub MCP server (spec: "Scope").
- `repoCloneToken` is never embedded in the prompt text — only in `environment.network.allowlist`'s header `transform` (spec: "Session Creation & Credentials").
- Default model is the alias `gemini-pro-latest` — never a versioned model string like `gemini-2.5-pro` (verified live: that string 400s with "no longer available to new users").
- Status→event mapping is exactly the table in the spec's "Event Translation" section — copy it verbatim, do not invent additional states.

---

## Task 1: Backend registration & config

**Files:**
- Modify: `packages/db/src/schema.ts:14`
- Modify: `apps/web/src/server/tick/adapters/types.ts:7`
- Modify: `apps/web/src/lib/env.ts` (after line 89, `FORGE_MA_DEFAULT_VAULT_ID`)
- Modify: `apps/web/src/lib/env.test.ts`
- Modify: `apps/web/.env.example`
- Modify: `apps/web/src/components/missions-table.tsx:97`
- Test: `apps/web/src/lib/env.test.ts`

**Interfaces:**
- Produces: `BackendKind` includes `'gemini-managed-agents'`. `env.GEMINI_API_KEY: string | undefined`. `env.FORGE_GEMINI_MODEL: string` (defaults to `'gemini-pro-latest'`).

- [ ] **Step 1: Write the failing tests for the two new env getters**

Add to `apps/web/src/lib/env.test.ts`, inside the existing `describe('tick env getters', ...)` block (after the `'defaults the git identity dispatched agents commit as'` test added earlier this session):

```ts
  it('defaults FORGE_GEMINI_MODEL to gemini-pro-latest, leaves GEMINI_API_KEY unset by default', () => {
    expect(env.FORGE_GEMINI_MODEL).toBe('gemini-pro-latest');
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('reads GEMINI_API_KEY and FORGE_GEMINI_MODEL overrides from process.env at access time', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.FORGE_GEMINI_MODEL = 'gemini-flash-latest';
    expect(env.GEMINI_API_KEY).toBe('test-key');
    expect(env.FORGE_GEMINI_MODEL).toBe('gemini-flash-latest');
    delete process.env.GEMINI_API_KEY;
    delete process.env.FORGE_GEMINI_MODEL;
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/lib/env.test.ts`
Expected: FAIL — `env.FORGE_GEMINI_MODEL` and `env.GEMINI_API_KEY` are not properties of `env` (TypeScript compile error surfaced as a test failure, or `undefined` mismatch if it type-checks loosely).

- [ ] **Step 3: Add the two getters to `env.ts`**

In `apps/web/src/lib/env.ts`, immediately after the `FORGE_MA_DEFAULT_VAULT_ID` getter (line 89) and before the `FORGE_GIT_AUTHOR_NAME` comment block, insert:

```ts
  get GEMINI_API_KEY(): string | undefined {
    return optional('GEMINI_API_KEY');
  },
  get FORGE_GEMINI_MODEL(): string {
    return optional('FORGE_GEMINI_MODEL') ?? 'gemini-pro-latest';
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/env.test.ts`
Expected: PASS (8 tests total in this file after this addition).

- [ ] **Step 5: Extend the `backend` enum in the DB schema**

In `packages/db/src/schema.ts`, change line 14 from:

```ts
export const backend = ['managed-agents', 'gateway'] as const;
```

to:

```ts
export const backend = ['managed-agents', 'gateway', 'gemini-managed-agents'] as const;
```

This is a plain `text()` column (`schema.ts:90`) with no DB-level CHECK constraint — no migration file is needed.

- [ ] **Step 6: Extend `BackendKind` in the adapter types**

In `apps/web/src/server/tick/adapters/types.ts`, change line 7 from:

```ts
export type BackendKind = 'managed-agents' | 'gateway';
```

to:

```ts
export type BackendKind = 'managed-agents' | 'gateway' | 'gemini-managed-agents';
```

- [ ] **Step 7: Fix the backend-label ternary in the missions table so it never mislabels a Gemini-backed mission**

`apps/web/src/components/missions-table.tsx:96-97` currently reads:

```tsx
                <DataChip title={mission.backend} className="relative">
                  {mission.backend === 'managed-agents' ? 'ma' : 'gw'}
```

This is a two-way ternary that would silently label every `'gemini-managed-agents'` mission `'gw'` (wrong) once the enum has a third value. Change it to:

```tsx
                <DataChip title={mission.backend} className="relative">
                  {mission.backend === 'managed-agents'
                    ? 'ma'
                    : mission.backend === 'gateway'
                      ? 'gw'
                      : 'gm'}
```

- [ ] **Step 8: Document the new env vars in `.env.example`**

Append to `apps/web/.env.example`, after the existing `FORGE_GIT_AUTHOR_EMAIL` line:

```
# Required for FORGE_BACKEND=gemini-managed-agents
# GEMINI_API_KEY=

# Gemini model alias to use. Defaults to gemini-pro-latest — do not pin a
# dated/versioned model string here (they get deprecated for new users).
# FORGE_GEMINI_MODEL=gemini-pro-latest
```

- [ ] **Step 9: Run typecheck across the whole web app to confirm nothing else broke**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS with no errors. (This confirms there is no other exhaustive `switch`/ternary on `Backend`/`BackendKind` anywhere in the app besides the one just fixed in Step 7 — `mission-filters.tsx`'s `BACKENDS` filter array is intentionally left as-is per the spec's "Explicitly Out of Scope" section; it's an additive filter list, not a mislabeling risk.)

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/schema.ts apps/web/src/server/tick/adapters/types.ts apps/web/src/lib/env.ts apps/web/src/lib/env.test.ts apps/web/.env.example apps/web/src/components/missions-table.tsx
git commit -m "feat(tick): register gemini-managed-agents as a backend kind"
```

---

## Task 2: `GeminiManagedAgentsAdapter` — session lifecycle

**Files:**
- Create: `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`
- Modify: `apps/web/src/server/tick/adapters/index.ts`
- Modify: `apps/web/src/server/tick/adapters/adapter-contract.test.ts`
- Test: `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts`

**Interfaces:**
- Consumes: `BackendAdapter`, `CreateSessionInput`, `CreateSessionResult`, `GetSessionResult`, `ListEventsInput`, `ListEventsResult`, `SessionLifecycle`, `ToolConfirmationDecision`, `BackendEvent` from `./types` (Task 1's `BackendKind` extension already lands before this task runs).
- Produces: `GeminiManagedAgentsAdapter` class and `GeminiManagedAgentsAdapterOptions` type, both exported from `./gemini-managed-agents`. `listEvents` itself is stubbed to return `{ events: [], hasMore: false }` in this task — Task 3 replaces the body. Internal state this task creates that Task 3 depends on: `private readonly latestInteractionId: Map<string, string>` (logical `sessionId` → physical Gemini interaction id — every `sendTurn`/`createSession` call updates it; every other method resolves through it first) and a private `request<T>(method, path, body?): Promise<T>` HTTP helper.

- [ ] **Step 1: Write the failing tests for `createSession`'s request shape**

Create `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiManagedAgentsAdapter } from './gemini-managed-agents';

const input = {
  agentId: 'agent_1',
  repoUrl: 'https://github.com/acme/api',
  repoCloneToken: 'ghs_test_token',
  baseBranch: 'main',
  prompt: 'do it',
};

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GeminiManagedAgentsAdapter.createSession', () => {
  it('attaches only code_execution (never an MCP server) and injects the clone token via environment.network.allowlist, not the prompt', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const result = await adapter.createSession(input);

    expect(result).toEqual({ sessionId: 'v1_abc' });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('gemini-pro-latest');
    expect(body.background).toBe(true);
    expect(body.tools).toEqual([{ type: 'code_execution' }]);
    expect(body.environment.network.allowlist).toContainEqual({
      domain: 'github.com',
      transform: { Authorization: 'Bearer ghs_test_token' },
    });
    expect(body.environment.network.allowlist).toContainEqual({
      domain: 'api.github.com',
      transform: { Authorization: 'Bearer ghs_test_token' },
    });
    expect(JSON.stringify(body.input)).not.toContain('ghs_test_token');
  });

  it('sends the x-goog-api-key header', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'my-key', model: 'gemini-pro-latest' });

    await adapter.createSession(input);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('my-key');
  });
});

describe('GeminiManagedAgentsAdapter session lifecycle', () => {
  it('getSession resolves through the latest interaction id after a sendTurn', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_second', status: 'in_progress' } }, // sendTurn
      { body: { id: 'v1_second', status: 'completed' } }, // getSession
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    await adapter.sendTurn(sessionId, 'continue');
    const session = await adapter.getSession(sessionId);

    expect(session).toEqual({ sessionId: 'v1_first', status: 'idle', stopReasonType: undefined });
    // The third call (getSession) must hit v1_second, not v1_first — Gemini
    // hands back a new interaction id on every follow-up turn.
    expect(calls[2]!.url).toContain('/v1beta/interactions/v1_second');
  });

  it('cancelSession posts to the /cancel endpoint of the latest interaction id', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }, { body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    await adapter.cancelSession(sessionId);

    expect(calls[1]!.url).toContain('/v1beta/interactions/v1_abc/cancel');
    expect(calls[1]!.init.method).toBe('POST');
  });

  it('confirmToolUse always throws — v1 attaches no tool that should need confirmation', async () => {
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    await expect(adapter.confirmToolUse('v1_abc', 'evt_1', { result: 'allow' })).rejects.toThrow(
      /should be unreachable/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters/gemini-managed-agents.test.ts`
Expected: FAIL — the module `./gemini-managed-agents` does not exist yet.

- [ ] **Step 3: Implement `GeminiManagedAgentsAdapter`**

Create `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`:

```ts
import type {
  BackendAdapter,
  BackendEvent,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
  ToolConfirmationDecision,
} from './types';

export type GeminiManagedAgentsAdapterOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
};

export type GeminiInteraction = {
  id: string;
  status: string;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
  steps?: Array<Record<string, unknown>>;
};

function buildSetupInstructions(input: CreateSessionInput): string {
  return (
    'Setup — run this first, using the code execution tool:\n' +
    '1. Configure git to authenticate via header (the real token is injected\n' +
    '   transparently by the network proxy for requests to github.com — you will\n' +
    '   never see it and must not try to obtain or embed one yourself):\n' +
    '   git config --global http.https://github.com/.extraHeader "Authorization: Bearer placeholder"\n' +
    `2. Clone the repository and check out the base branch:\n` +
    `   git clone ${input.repoUrl} repo && cd repo && git checkout ${input.baseBranch}\n` +
    'Do all further work inside the `repo` directory.'
  );
}

/**
 * Gemini Interactions API adapter (https://ai.google.dev/api/interactions-api).
 *
 * Plain HTTP — no SDK dependency, same precedent as GatewayAdapter. Gemini has
 * no persistent multi-turn session id: every interaction (including follow-ups
 * chained via previous_interaction_id) gets a fresh id. Forge's task.sessionId
 * is set once at createSession and never changes, so this adapter tracks,
 * per logical session, which physical interaction id is currently "live" —
 * the one every other method should actually poll/act on.
 */
export class GeminiManagedAgentsAdapter implements BackendAdapter {
  readonly kind = 'gemini-managed-agents' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly latestInteractionId = new Map<string, string>();

  constructor(opts: GeminiManagedAgentsAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const body = {
      model: this.model,
      background: true,
      tools: [{ type: 'code_execution' }],
      environment: {
        type: 'remote',
        network: {
          allowlist: [
            { domain: 'github.com', transform: { Authorization: `Bearer ${input.repoCloneToken}` } },
            { domain: 'api.github.com', transform: { Authorization: `Bearer ${input.repoCloneToken}` } },
            { domain: '*' },
          ],
        },
      },
      input: `${buildSetupInstructions(input)}\n\n---\n\n${input.prompt}`,
    };

    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', body);
    this.latestInteractionId.set(interaction.id, interaction.id);
    return { sessionId: interaction.id };
  }

  async sendTurn(sessionId: string, text: string): Promise<void> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', {
      model: this.model,
      background: true,
      previous_interaction_id: physicalId,
      input: text,
    });
    this.latestInteractionId.set(sessionId, interaction.id);
  }

  async listEvents(_input: ListEventsInput): Promise<ListEventsResult> {
    // Replaced in Task 3 with the full status/step translation.
    return { events: [], hasMore: false };
  }

  async getSession(sessionId: string): Promise<GetSessionResult> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
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

  async cancelSession(sessionId: string): Promise<void> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
    await this.request('POST', `/v1beta/interactions/${physicalId}/cancel`);
  }

  async confirmToolUse(
    _sessionId: string,
    _toolUseEventId: string,
    _decision: ToolConfirmationDecision,
  ): Promise<void> {
    throw new Error(
      'GeminiManagedAgentsAdapter: confirmToolUse should be unreachable — v1 never attaches a tool requiring confirmation',
    );
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'x-goog-api-key': this.apiKey };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GeminiApiError(res.status, method, path, text);
    }

    return res.json() as Promise<T>;
  }
}

function normalizeStatus(status: string): SessionLifecycle {
  switch (status) {
    case 'queued':
    case 'in_progress':
      return 'running';
    case 'cancelled':
      return 'terminated';
    default:
      // completed / failed / incomplete / budget_exceeded / requires_action —
      // the turn is over one way or another; "idle" means "ball is in our court".
      return 'idle';
  }
}

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Gemini ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'GeminiApiError';
  }
}
```

Note the type-only `BackendEvent` import is unused by this task's code (Task 3 needs it) — remove it from the import list for now so `pnpm typecheck`/lint don't flag an unused import; Task 3 adds it back when `listEvents` is implemented for real. Revise the import block to:

```ts
import type {
  BackendAdapter,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
  ToolConfirmationDecision,
} from './types';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters/gemini-managed-agents.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the adapter in `getAdapter()`**

In `apps/web/src/server/tick/adapters/index.ts`, add the import and a new `case`. The full file becomes:

```ts
import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/lib/env';

import { GatewayAdapter } from './gateway';
import { GeminiManagedAgentsAdapter } from './gemini-managed-agents';
import { ManagedAgentsAdapter } from './managed-agents';
import type { BackendAdapter, BackendKind } from './types';

export * from './types';
export { ManagedAgentsAdapter } from './managed-agents';
export { GatewayAdapter } from './gateway';
export { GeminiManagedAgentsAdapter } from './gemini-managed-agents';

const cache = new Map<BackendKind, BackendAdapter>();

export function getAdapter(kind: BackendKind): BackendAdapter {
  const cached = cache.get(kind);
  if (cached) return cached;

  let adapter: BackendAdapter;
  switch (kind) {
    case 'managed-agents': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required for managed-agents backend');
      }
      if (!env.FORGE_MA_ENVIRONMENT_ID) {
        throw new Error('FORGE_MA_ENVIRONMENT_ID is required for managed-agents backend');
      }
      adapter = new ManagedAgentsAdapter({
        apiKey: env.ANTHROPIC_API_KEY,
        environmentId: env.FORGE_MA_ENVIRONMENT_ID,
        defaultVaultId: env.FORGE_MA_DEFAULT_VAULT_ID,
        client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL }),
      });
      break;
    }
    case 'gateway': {
      if (!env.GATEWAY_URL) {
        throw new Error('GATEWAY_URL is required for gateway backend');
      }
      if (!env.GATEWAY_API_KEY) {
        throw new Error('GATEWAY_API_KEY is required for gateway backend');
      }
      adapter = new GatewayAdapter({ baseUrl: env.GATEWAY_URL, apiKey: env.GATEWAY_API_KEY, environmentId: env.GATEWAY_ENVIRONMENT_ID });
      break;
    }
    case 'gemini-managed-agents': {
      if (!env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required for gemini-managed-agents backend');
      }
      adapter = new GeminiManagedAgentsAdapter({
        apiKey: env.GEMINI_API_KEY,
        model: env.FORGE_GEMINI_MODEL,
      });
      break;
    }
    default:
      throw new Error(`unknown backend kind: ${String(kind)}`);
  }

  cache.set(kind, adapter);
  return adapter;
}
```

- [ ] **Step 6: Register the adapter in the shared contract test**

In `apps/web/src/server/tick/adapters/adapter-contract.test.ts`, add the import and a third `adapterSuite` call, and widen the `kind` assertion. Change:

```ts
import { GatewayAdapter, GatewayApiError } from './gateway';
import { ManagedAgentsAdapter } from './managed-agents';
import type { BackendAdapter } from './types';
```

to:

```ts
import { GatewayAdapter, GatewayApiError } from './gateway';
import { GeminiManagedAgentsAdapter } from './gemini-managed-agents';
import { ManagedAgentsAdapter } from './managed-agents';
import type { BackendAdapter } from './types';
```

Change the `kind` assertion inside `adapterSuite`:

```ts
    it('has the correct kind', () => {
      const adapter = create();
      expect(['managed-agents', 'gateway', 'gemini-managed-agents']).toContain(adapter.kind);
    });
```

Add a third suite registration after the existing `GatewayAdapter` one:

```ts
// Gemini adapter — plain fetch, no real HTTP in these tests (fetch isn't
// invoked by anything adapter-contract.test.ts calls, since it only checks
// method presence, not behavior).
adapterSuite('GeminiManagedAgentsAdapter', () =>
  new GeminiManagedAgentsAdapter({
    apiKey: 'test-key',
    model: 'gemini-pro-latest',
  }),
);
```

- [ ] **Step 7: Run the full adapters test directory**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters`
Expected: PASS — `adapter-contract.test.ts` (now with a third suite, 22 tests total), `gemini-managed-agents.test.ts` (5 tests), `managed-agents.test.ts` (4 tests) all green.

- [ ] **Step 8: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9 (controller-run manual validation, not a subagent step — optional, non-blocking):**

Before trusting the git-auth-header design above in production, the spec explicitly flags one thing that needs a live empirical check: whether Gemini's egress-proxy header injection actually overrides/supplies the `Authorization` header for a `git`-issued HTTPS request the way it did for the plain `curl` test used to verify credential injection generally. If a `GEMINI_API_KEY` and a scoped-down throwaway GitHub token are available, run:

```bash
curl -sS -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-pro-latest",
    "tools": [{"type": "code_execution"}],
    "environment": {"type": "remote", "network": {"allowlist": [
      {"domain": "api.github.com", "transform": {"Authorization": "Bearer '"$GITHUB_TEST_TOKEN"'"}},
      {"domain": "*"}
    ]}},
    "input": "Using code execution, run: git config --global http.https://api.github.com/.extraHeader \"Authorization: Bearer placeholder\" ; then run: curl -sS https://api.github.com/user ; print the raw output."
  }'
```

Inspect the `code_execution_result` step: a real authenticated GitHub user JSON body confirms the design works as specified; a 401/"Bad credentials" body means the git-auth-header approach needs revisiting (most likely: the agent needs to be told to actually send *some* `Authorization` header value for the proxy to intercept and replace, rather than sending none at all). If no key/token is available, skip this step and note it as skipped in the task report — it does not block this task or Task 3, since it's a live-behavior confirmation of an already-implemented, already-tested code path, not a prerequisite for writing that code.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/tick/adapters/gemini-managed-agents.ts apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts apps/web/src/server/tick/adapters/index.ts apps/web/src/server/tick/adapters/adapter-contract.test.ts
git commit -m "feat(tick): add GeminiManagedAgentsAdapter session lifecycle"
```

---

## Task 3: `GeminiManagedAgentsAdapter.listEvents` — event translation

**Design note (read before implementing):** the natural approach — rebuild the full synthetic event list fresh on every poll, then find `afterEventId` in it and slice — has a real bug: whenever a genuinely-new event (e.g. the terminal status) appears in the same poll as an already-returned event whose identity is recomputed each time (e.g. a usage/cost event keyed by the current cumulative token count), the recomputed event's new ID never matches the old cursor, `findIndex` returns `-1`, and the fallback-to-full-list behavior **re-emits everything already seen**, including events positioned *after* the point where the new item was inserted in a fixed schema order — a fixed-position rebuild cannot guarantee "in-order = seen-order" once more than one thing can newly appear on the same poll. `poller.ts:82-92` confirms `afterEventId` is a durable DB-backed cursor (`ledgerEvents.sourceEventId`, read fresh every tick), not something this adapter controls the shape of — so the fix must live entirely in how the list is built.

The fix: maintain one **append-only** per-session event log in memory (`Map<sessionId, BackendEvent[]>`). Each poll only ever pushes newly-discovered items onto the end — never rebuilds, reorders, or removes. Because nothing already in the log ever moves, any previously-returned ID is guaranteed to still be found at the same index by `findIndex`, and slicing after it always returns exactly the genuinely-new suffix, regardless of what combination of steps/terminal-status/usage-delta became new in a given poll. This is the same reason `ManagedAgentsAdapter`/`GatewayAdapter`'s `findIndex`+`slice` pattern works correctly for them — their event lists come from a real backend that only ever appends, too; this task makes this adapter behave the same way rather than re-deriving a fresh list from a snapshot each time.

**Files:**
- Modify: `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`
- Test: `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts`

**Interfaces:**
- Consumes: `latestInteractionId: Map<string, string>` and `request<T>()` from Task 2's `GeminiManagedAgentsAdapter`.
- Produces: a fully working `listEvents(input: ListEventsInput): Promise<ListEventsResult>`, plus four new private fields, all consumed by nothing outside this class:
  - `private readonly eventLog = new Map<string, BackendEvent[]>()` — the append-only per-session log described above.
  - `private readonly processedStepCount = new Map<string, number>()` — how many of `interaction.steps[]` have already been translated into an event, per session (steps are only ever appended by Gemini, so this is a "resume from here" count, not a set of seen ids — see the collision note in Step 3).
  - `private readonly terminalEmitted = new Set<string>()` — whether the one-time terminal-status event has already been appended for this session.
  - `private readonly lastSeenUsage = new Map<string, { input: number; output: number }>()` — last cumulative usage total seen per session, for deciding whether *this* poll warrants appending one new usage-delta event (the delta value itself, once appended, is fixed forever — it is never recomputed on a later poll).

- [ ] **Step 1: Write the failing tests for status→event translation**

Append to `apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts`:

```ts
describe('GeminiManagedAgentsAdapter.listEvents — state-driving translation', () => {
  it('emits session.status_running on the first poll of an in_progress interaction', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // listEvents
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events).toEqual([
      { id: `${sessionId}:status:running`, type: 'session.status_running', processedAt: null, raw: {} },
    ]);
  });

  it('emits session.status_idle with stop_reason end_turn when the interaction completes', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'completed', steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events).toContainEqual({
      id: `${sessionId}:status:completed`,
      type: 'session.status_idle',
      processedAt: null,
      raw: { stop_reason: { type: 'end_turn' } },
    });
  });

  it.each([
    ['failed', 'session.error'],
    ['incomplete', 'session.error'],
    ['budget_exceeded', 'session.error'],
    ['requires_action', 'session.error'],
    ['cancelled', 'session.status_terminated'],
  ])('maps status %s to %s', async (status, expectedType) => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status, steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events.some((e) => e.type === expectedType && e.id === `${sessionId}:status:${status}`)).toBe(
      true,
    );
  });

  it('does not re-emit the running transition once afterEventId has passed it', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // first poll
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // second poll, still in_progress
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    expect(second.events).toEqual([]);
  });
});

describe('GeminiManagedAgentsAdapter.listEvents — observability translation', () => {
  it('translates thought/model_output/code_execution_call/code_execution_result steps, each once', async () => {
    const steps = [
      { id: 'call_1', type: 'code_execution_call', arguments: { language: 'python', code: 'ls' } },
      { call_id: 'call_1', type: 'code_execution_result', result: 'file.txt', is_error: false },
      { signature: 'sig', type: 'thought' },
      { content: [{ type: 'text', text: 'done' }], type: 'model_output' },
    ];
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    // Event ids are derived from the step's array index, not id/call_id — a
    // code_execution_call and its paired code_execution_result share the same
    // call_id, so an id/call_id-keyed scheme would collide the two into the
    // same synthetic event id and silently drop one at the ledger's
    // (taskId, sourceEventId) uniqueness constraint.
    expect(events).toContainEqual(
      expect.objectContaining({ id: `${sessionId}:step:0`, type: 'agent.tool_use' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ id: `${sessionId}:step:1`, type: 'agent.tool_result' }),
    );
    expect(events.some((e) => e.type === 'agent.thinking')).toBe(true);
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
  });

  it('only emits events for steps new since the last poll', async () => {
    const stepsRoundOne = [{ id: 'call_1', type: 'code_execution_call', arguments: {} }];
    const stepsRoundTwo = [
      ...stepsRoundOne,
      { call_id: 'call_1', type: 'code_execution_result', result: 'ok', is_error: false },
    ];
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: stepsRoundOne } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: stepsRoundTwo } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    // The result step is at absolute array index 1 (round two's second element)
    // — index-based ids, not call_id-based, per the note above.
    expect(second.events).toEqual([
      expect.objectContaining({ id: `${sessionId}:step:1`, type: 'agent.tool_result' }),
    ]);
  });
});

describe('GeminiManagedAgentsAdapter.listEvents — cost delta tracking', () => {
  it('converts cumulative usage into a per-poll delta, and never recomputes an already-appended delta', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 100, total_output_tokens: 50 },
        },
      },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 150, total_output_tokens: 90 },
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const firstUsage = first.events.find((e) => e.type === 'span.model_request_end');
    expect(firstUsage?.raw).toEqual({ model_usage: { input_tokens: 100, output_tokens: 50 } });

    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });
    const secondUsage = second.events.find((e) => e.type === 'span.model_request_end');
    expect(secondUsage?.raw).toEqual({ model_usage: { input_tokens: 50, output_tokens: 40 } });
    expect(secondUsage!.id).not.toBe(firstUsage!.id);
  });

  it('regression: a terminal-status event that newly appears in the same poll as an already-cursored usage event is not dropped by the slice', async () => {
    // This is the exact bug a fixed-position "rebuild fresh every poll" design
    // has: the terminal event and the usage event both become new at different
    // times, and once the usage event from poll 1 is used as poll 2's cursor,
    // a naive rebuild positions the terminal event "before" that cursor and
    // silently drops it. The append-only log must not have this problem.
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 100, total_output_tokens: 50 },
        },
      },
      {
        body: {
          id: 'v1_abc',
          status: 'completed',
          steps: [],
          usage: { total_input_tokens: 150, total_output_tokens: 90 },
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId }); // usage event 1 appended
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    expect(second.events).toContainEqual({
      id: `${sessionId}:status:completed`,
      type: 'session.status_idle',
      processedAt: null,
      raw: { stop_reason: { type: 'end_turn' } },
    });
    expect(second.events.some((e) => e.type === 'span.model_request_end')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters/gemini-managed-agents.test.ts`
Expected: FAIL — `listEvents` currently always returns `{ events: [], hasMore: false }`.

- [ ] **Step 3: Implement the full `listEvents` translation**

In `apps/web/src/server/tick/adapters/gemini-managed-agents.ts`, restore the `BackendEvent` import:

```ts
import type {
  BackendAdapter,
  BackendEvent,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
  ToolConfirmationDecision,
} from './types';
```

Add four new private fields to the class, alongside `latestInteractionId`:

```ts
  // Append-only per-session event log — see the design note above this task.
  // Never rebuilt or reordered; each poll only ever pushes newly-discovered items.
  private readonly eventLog = new Map<string, BackendEvent[]>();
  // How many of interaction.steps[] have already been translated into an
  // event, per session — steps are only ever appended by Gemini, so this is
  // a plain "resume from here" count, not a set of seen ids.
  private readonly processedStepCount = new Map<string, number>();
  // Whether the one-time terminal status event has already been appended.
  private readonly terminalEmitted = new Set<string>();
  // Last cumulative usage totals seen, for deciding whether this poll
  // warrants appending ONE new usage-delta event. Once appended, a usage
  // event's delta value is fixed forever — it is never recomputed later.
  private readonly lastSeenUsage = new Map<string, { input: number; output: number }>();
```

Replace the stub `listEvents` method with:

```ts
  async listEvents(input: ListEventsInput): Promise<ListEventsResult> {
    const physicalId = this.latestInteractionId.get(input.sessionId) ?? input.sessionId;
    const interaction = await this.request<GeminiInteraction>(
      'GET',
      `/v1beta/interactions/${physicalId}`,
    );

    const log = this.eventLog.get(input.sessionId) ?? [];
    if (log.length === 0) {
      log.push({
        id: `${input.sessionId}:status:running`,
        type: 'session.status_running',
        processedAt: null,
        raw: {},
      });
    }

    const allSteps = interaction.steps ?? [];
    const processedCount = this.processedStepCount.get(input.sessionId) ?? 0;
    for (let i = processedCount; i < allSteps.length; i++) {
      const step = allSteps[i]!;
      // Index-based, not id/call_id-based: a code_execution_call and its
      // paired code_execution_result share the same call_id, so keying by
      // that would collide the two into the same synthetic event id.
      const eventId = `${input.sessionId}:step:${i}`;
      const type = step.type as string | undefined;
      if (type === 'thought') {
        log.push({ id: eventId, type: 'agent.thinking', processedAt: null, raw: step });
      } else if (type === 'model_output') {
        log.push({ id: eventId, type: 'agent.message', processedAt: null, raw: step });
      } else if (type === 'code_execution_call') {
        log.push({ id: eventId, type: 'agent.tool_use', processedAt: null, raw: step });
      } else if (type === 'code_execution_result') {
        log.push({ id: eventId, type: 'agent.tool_result', processedAt: null, raw: step });
      }
      // Unrecognized step types are skipped — informational-only, matching
      // state.ts's convention of letting unrecognized events fall through.
    }
    this.processedStepCount.set(input.sessionId, allSteps.length);

    if (!this.terminalEmitted.has(input.sessionId)) {
      const statusEvent = terminalStatusEvent(input.sessionId, interaction.status);
      if (statusEvent) {
        log.push(statusEvent);
        this.terminalEmitted.add(input.sessionId);
      }
    }

    const prevUsage = this.lastSeenUsage.get(input.sessionId) ?? { input: 0, output: 0 };
    const currentInput = interaction.usage?.total_input_tokens ?? 0;
    const currentOutput = interaction.usage?.total_output_tokens ?? 0;
    const inputDelta = Math.max(0, currentInput - prevUsage.input);
    const outputDelta = Math.max(0, currentOutput - prevUsage.output);
    if (inputDelta > 0 || outputDelta > 0) {
      // id uses the log's length at this moment — always higher than any
      // previous usage event's id, since the log only ever grows.
      log.push({
        id: `${input.sessionId}:usage:${log.length}`,
        type: 'span.model_request_end',
        processedAt: null,
        raw: { model_usage: { input_tokens: inputDelta, output_tokens: outputDelta } },
      });
      this.lastSeenUsage.set(input.sessionId, { input: currentInput, output: currentOutput });
    }

    this.eventLog.set(input.sessionId, log);

    let events = log;
    if (input.afterEventId) {
      const idx = log.findIndex((e) => e.id === input.afterEventId);
      events = idx >= 0 ? log.slice(idx + 1) : log;
    }

    const latest = events.at(-1);
    return { events, latestEventId: latest?.id ?? input.afterEventId, hasMore: false };
  }
```

Add this module-level helper function, below the class (after the closing `}` of `GeminiManagedAgentsAdapter`, before `normalizeStatus`):

```ts
function terminalStatusEvent(sessionId: string, status: string): BackendEvent | null {
  switch (status) {
    case 'completed':
      return {
        id: `${sessionId}:status:completed`,
        type: 'session.status_idle',
        processedAt: null,
        raw: { stop_reason: { type: 'end_turn' } },
      };
    case 'failed':
    case 'incomplete':
    case 'budget_exceeded':
      return {
        id: `${sessionId}:status:${status}`,
        type: 'session.error',
        processedAt: null,
        raw: { message: `gemini interaction ${status}` },
      };
    case 'requires_action':
      return {
        id: `${sessionId}:status:requires_action`,
        type: 'session.error',
        processedAt: null,
        raw: { message: 'unexpected requires_action: v1 attaches no tool that should produce this state' },
      };
    case 'cancelled':
      return { id: `${sessionId}:status:cancelled`, type: 'session.status_terminated', processedAt: null, raw: {} };
    default:
      return null; // queued / in_progress — not yet settled
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters/gemini-managed-agents.test.ts`
Expected: PASS (17 tests total in this file after Tasks 2 and 3 combined: 5 from Task 2, 12 from Task 3 including the `it.each` block's 5 cases).

- [ ] **Step 5: Run the full adapters directory and typecheck**

Run: `cd apps/web && pnpm vitest run src/server/tick/adapters && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 6: Run the whole workspace test suite**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm -r test`
Expected: PASS — every existing test file still green, plus the new ones from Tasks 1–3.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/tick/adapters/gemini-managed-agents.ts apps/web/src/server/tick/adapters/gemini-managed-agents.test.ts
git commit -m "feat(tick): translate Gemini interaction polling into BackendEvents"
```

---

## After all tasks: whole-branch review

Once Tasks 1–3 are complete, dispatch a final whole-branch code review (per `superpowers:subagent-driven-development`) covering the full diff against `main`. Pay particular attention to:
- Does the `latestInteractionId` map ever leak (grow unbounded)? It's fine for now — one entry per in-flight task, cleared implicitly when the process restarts — but flag it if the reviewer sees a cheap bound worth adding (e.g. evict on terminal status).
- Does `buildEventList`'s reconstruct-the-whole-list-every-poll approach hold up as steps grow large over a long-running task? (Likely fine — Gemini's own interaction object already holds the full step history server-side; this adapter isn't storing anything Gemini doesn't already store.)
- Confirm no MCP/tool-confirmation code path was accidentally wired up anywhere (grep for `confirmToolUse` call sites reaching this adapter — there should be none, since v1 attaches no tool needing it).
