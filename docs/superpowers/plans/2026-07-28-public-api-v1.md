# Public API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Forge operable from a CLI — a versioned `/api/v1` surface covering mission lifecycle, task operations, the ledger, and repo policy, authenticated by a token that resolves to a real user.

**Architecture:** One Zod schema per operation drives validation, types, and a generated OpenAPI spec. Auth uses better-auth's `device-authorization` and `bearer` plugins so a CLI token resolves through the same `auth.api.getSession()` call the app already uses — no new identity model. Business logic stays in `lib/`; routes are thin.

**Tech Stack:** Next.js 16 App Router, better-auth 1.6.9, Zod 4, Drizzle over libSQL, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-public-api-v1-design.md`. It governs.
- Ownership failures return **404, not 403** — existence must not be observable across accounts. `getMission(id, userId)` and `getTask(id, userId)` already return null for both cases. Do not weaken this.
- The credential resolves to a **user**. No synthetic identities, no static shared key.
- Token accepted as `Authorization: Bearer <token>` **or** `x-api-key: <token>`, bearer checked first.
- Business logic lives in `lib/`. Routes are thin transports. Never duplicate logic into a route.
- Error body is `{ error: { code, message } }` with conventional status codes.
- Every operation gets an ownership test that **fails if the scoping is removed**.
- Mutation-test every behaviour: revert it, confirm a **specific named** test fails, restore. **Print the mutated source and confirm it changed before running the suite** — five no-op mutations happened on this project where a regex matched nothing and produced a green suite that proved nothing.
- Report mutation results **per behaviour, never bundled**. A bundled report earlier misattributed which assertion failed and cost a review round.
- No migration is expected. If one becomes necessary it must be generated with `pnpm --filter @forge/db db:generate` and its filename grep-verified in `packages/db/migrations/meta/_journal.json` before commit. Never hand-create one. Latest is `0019_futuristic_cable`.
- Run `pnpm typecheck && pnpm -r lint && pnpm -r test` before every commit; all three clean.
- Do not extract secrets, read `.env` files for credential values, forge sessions or cookies, bypass authentication for any reason, or start a dev server to log in.

---

## File Structure

**Created**
- `apps/web/src/lib/api/auth.ts` — `withApiAuth()`, the single auth gate for v1 routes
- `apps/web/src/lib/api/respond.ts` — `ok()` / `fail()` response helpers, one error shape
- `apps/web/src/lib/api/schemas.ts` — Zod schema registry, one per operation
- `apps/web/src/app/(app)/api/v1/**` — the route handlers
- `apps/web/src/lib/api/openapi.ts` — derives the spec from `schemas`
- `docs/api/openapi.json` — generated, committed, checked by a test

**Modified**
- `apps/web/src/lib/auth.ts` — register `bearer` and `device-authorization` plugins
- `apps/web/src/lib/api-auth.ts` — accept `x-api-key` as a bearer alias
- `package.json` (root) — an `api:spec` script

**Deleted** (zero callers, verified)
- `api/missions/route.ts`, `api/missions/[missionId]/route.ts`, and the `plan`, `start`, `cancel`, `retry`, `tasks` subroutes

**Untouched:** `retrospect`, the SSE `stream` route (see #43), `proposals/[proposalId]` — all have in-app callers and are out of v1 scope.

---

## Task 1: Auth spike — resolve the middleware question empirically

The spec proposes `middleware.ts` for centralised auth but flags that Next middleware defaults to the edge runtime while better-auth needs database access. **Nothing may depend on middleware until this task settles it.**

**Files:**
- Create (temporarily): `apps/web/src/middleware.ts`
- Create: `apps/web/src/lib/api/auth.ts`
- Create: `apps/web/src/lib/api/auth.test.ts`

**Interfaces:**
- Produces: `withApiAuth<T>(handler: (user: ApiUser, req: Request, ctx: T) => Promise<Response>): (req: Request, ctx: T) => Promise<Response>`

- [ ] **Step 1: Spike the middleware path**

Create `apps/web/src/middleware.ts`:

```ts
export const config = { matcher: '/api/v1/:path*', runtime: 'nodejs' };

export function middleware() {
  // Spike only — proving the Node runtime is available to middleware.
  return undefined;
}
```

Run: `cd apps/web && pnpm build 2>&1 | tail -20`

**Decision gate.** If the build succeeds and the `runtime: 'nodejs'` config is accepted, middleware is viable — record that in the report. If it errors, or Next warns that the runtime option is unsupported, **delete `middleware.ts` and proceed with the wrapper**. Do not spend more than one build cycle on this. Record which path you took and the exact output that decided it.

- [ ] **Step 2: Write the failing test for the wrapper**

The wrapper is built either way — if middleware works it composes with it; if not it is the whole gate.

Create `apps/web/src/lib/api/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const apiAuth = vi.fn();
vi.mock('@/lib/api-auth', () => ({ apiAuth: () => apiAuth() }));

const { withApiAuth } = await import('./auth');

describe('withApiAuth', () => {
  it('passes the authenticated user to the handler', async () => {
    apiAuth.mockResolvedValue([{ id: 'u1', name: 'U', email: 'u@x' }, null]);
    const handler = withApiAuth(async (user) => Response.json({ id: user.id }));
    const res = await handler(new Request('http://x'), {});
    expect(await res.json()).toEqual({ id: 'u1' });
  });

  it('returns apiAuth\'s rejection without invoking the handler', async () => {
    const rejection = Response.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 });
    apiAuth.mockResolvedValue([null, rejection]);
    const spy = vi.fn();
    const handler = withApiAuth(async () => { spy(); return Response.json({}); });
    const res = await handler(new Request('http://x'), {});
    expect(res.status).toBe(401);
    // The gate must short-circuit — a handler that runs has already touched data.
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/lib/api/auth.test.ts`
Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 4: Implement the wrapper**

Create `apps/web/src/lib/api/auth.ts`:

```ts
import { apiAuth, type ApiUser } from '@/lib/api-auth';

/**
 * The single auth gate for /api/v1 routes.
 *
 * Centralising this is the point: auth was previously called per-route, which
 * is how apiAuth() and withAuth() drifted into different failure modes (fixed
 * 2026-07-27, commit 3536274). One wrapper means one place to reason about.
 *
 * Composes with middleware if the Node-runtime spike succeeded; stands alone
 * if it did not. Either way a route cannot forget the gate, because the
 * wrapper is what produces the exported handler.
 */
export function withApiAuth<T>(
  handler: (user: ApiUser, req: Request, ctx: T) => Promise<Response>,
): (req: Request, ctx: T) => Promise<Response> {
  return async (req, ctx) => {
    const [user, rejection] = await apiAuth();
    if (rejection) return rejection;
    return handler(user, req, ctx);
  };
}
```

- [ ] **Step 5: Run the tests**

Expected: PASS, 2 tests.

- [ ] **Step 6: Mutation-test, per behaviour**

One at a time, printing the mutated source each time and confirming it changed:

1. Change `if (rejection) return rejection;` to `if (false) return rejection;` → the short-circuit test must fail.
2. Change the handler call to pass a literal user instead of the resolved one → the first test must fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/lib/api apps/web/src/middleware.ts 2>/dev/null || git add apps/web/src/lib/api
git commit -m "feat(api): add the v1 auth gate, with the middleware question settled"
```

---

## Task 2: Machine credentials — bearer, x-api-key, device flow

**Files:**
- Modify: `apps/web/src/lib/auth.ts`
- Modify: `apps/web/src/lib/api-auth.ts`
- Test: `apps/web/src/lib/api-auth.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `Authorization: Bearer <token>` and `x-api-key: <token>` resolve to a user session on every endpoint that calls `apiAuth()` or `withAuth()`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/lib/api-auth.test.ts`:

```ts
it('accepts a token presented as x-api-key by aliasing it to Authorization', async () => {
  // managed-agents (the sibling engine) accepts `x-api-key` first, else
  // `Authorization: Bearer`. Matching that pair lets one CLI speak to both.
  headersMock.mockResolvedValue(new Headers({ 'x-api-key': 'tok_abc' }));
  vi.mocked(auth.api.getSession).mockImplementation(async ({ headers }) => {
    return headers.get('authorization') === 'Bearer tok_abc'
      ? ({ user: { id: 'u1', name: 'A', email: 'a@x' } } as never)
      : null;
  });
  const [user] = await apiAuth();
  expect(user?.id).toBe('u1');
});

it('prefers an explicit Authorization header over x-api-key', async () => {
  headersMock.mockResolvedValue(new Headers({
    authorization: 'Bearer real', 'x-api-key': 'ignored',
  }));
  vi.mocked(auth.api.getSession).mockImplementation(async ({ headers }) => {
    return headers.get('authorization') === 'Bearer real'
      ? ({ user: { id: 'u2', name: 'B', email: 'b@x' } } as never)
      : null;
  });
  const [user] = await apiAuth();
  expect(user?.id).toBe('u2');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/web && pnpm vitest run src/lib/api-auth.test.ts`
Expected: FAIL — `x-api-key` is not read.

- [ ] **Step 3: Register the plugins**

In `apps/web/src/lib/auth.ts`, add to the `betterAuth({...})` config:

```ts
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';

// bearer converts `Authorization: Bearer <token>` into the session cookie
// better-auth already understands, so apiAuth()/withAuth() need no change and
// every ownership check keeps working against a real user session.
// device-authorization is the `gh auth login` flow a CLI uses to obtain one.
plugins: [bearer(), deviceAuthorization()],
```

Verify the exact import paths against `node_modules/better-auth/dist/plugins/` before assuming them; if the package exports them from `better-auth/plugins`, use that form.

- [ ] **Step 4: Alias x-api-key**

In `apps/web/src/lib/api-auth.ts`, replace the single line

```ts
    session = await auth.api.getSession({ headers: await headers() });
```

inside the existing `try` block with:

```ts
    session = await auth.api.getSession({ headers: withBearerAlias(await headers()) });
```

and add above `apiAuth`:

```ts
/**
 * Accepts the sibling managed-agents engine's header convention so one CLI
 * can speak to both products without special-casing. Authorization wins when
 * both are present — an explicit auth header is the more specific signal.
 * The alias is all that is needed because better-auth's bearer plugin turns
 * `Authorization: Bearer` into the session cookie every ownership check
 * already reads.
 */
function withBearerAlias(incoming: Headers): Headers {
  const apiKey = incoming.get('x-api-key');
  if (!apiKey || incoming.get('authorization')) return incoming;
  const resolved = new Headers(incoming);
  resolved.set('authorization', `Bearer ${apiKey}`);
  return resolved;
}
```

`withAuth()` reads the same session but is browser-only, so it does not need the alias.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Mutation-test, per behaviour**

1. Remove the `x-api-key` aliasing → the alias test must fail.
2. Invert the precedence so `x-api-key` overwrites `authorization` → the precedence test must fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/lib/auth.ts apps/web/src/lib/api-auth.ts apps/web/src/lib/api-auth.test.ts
git commit -m "feat(auth): accept bearer and x-api-key, add the device flow"
```

---

## Task 2b: Make the auth surface safe to merge

Added after Task 2's adversarial review, which the spec requires before the bearer and device-flow paths merge. The review found the device flow is live, publicly mounted, and mints full user sessions with no consent surface. This task closes what must close now and defers what cannot be done properly yet.

**Files:**
- Modify: `apps/web/src/lib/auth.ts`
- Modify: `apps/web/src/lib/api-auth.ts` and its test
- Modify: `apps/web/src/app/(app)/api/auth/[...all]/route.ts`
- Modify: `packages/db/src/schema.ts` + a generated migration

- [ ] **Step 1: Unregister `deviceAuthorization()`**

`toNextJsHandler(auth)` mounts the entire better-auth router publicly, so registering the plugin put five endpoints live: `device/code`, `device/token`, `device`, `device/approve`, `device/deny`. Three defects compound:

- `deviceApprove` guards ownership with `if (record.userId && record.userId !== session.user.id)`. A fresh row has `userId` NULL, so the guard never fires — **any** logged-in user's approval binds the row to themselves and hands the code-holder a full session for that user.
- `validateClient` is undefined, so `client_id` is unvalidated — any string is accepted.
- `scope` is accepted, stored, and echoed back, but `/device/token` returns `createSession(user.id)` — an ordinary unscoped session. A CLI asking for `missions:read` gets a token that can delete the account.

Nothing supplies the missing proof, because the consent page that would name the client and require the human to type the code **does not exist** — `verification_uri_complete` points at a 404. Remove the plugin from the `plugins` array. Keep `bearer()`.

Leave a comment stating the three preconditions for its return (consent page, `validateClient` allow-list, scope either enforced or rejected) so re-enabling is a deliberate act, not a one-line revert.

- [ ] **Step 2: Stop leaking the session token in a response header**

`bearer()`'s after-hook matcher is literally `return true`. On every response that sets a session cookie — including pre-existing email sign-in, sign-up, and the GitHub OAuth callback — it copies the raw session token into a `set-auth-token` header and adds it to `Access-Control-Expose-Headers`. A credential that was HttpOnly-cookie-only is now an ordinary header value that logs, proxies, and caches will handle.

The option to disable this does not exist in 1.6.9. Strip it at the boundary instead:

```ts
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

const handlers = toNextJsHandler(auth);

/**
 * The bearer plugin unconditionally echoes the raw session token in a
 * `set-auth-token` response header. We register bearer for its REQUEST side
 * only — `Authorization: Bearer` resolving to a session — and want nothing to
 * do with its response side, which duplicates an HttpOnly credential into a
 * plain header on every browser login. 1.6.9 exposes no option to disable it,
 * so strip it here.
 */
function stripAuthTokenHeader(res: Response): Response {
  if (!res.headers.has('set-auth-token')) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-auth-token');
  const exposed = headers.get('access-control-expose-headers');
  if (exposed) {
    const kept = exposed.split(',').map((h) => h.trim())
      .filter((h) => h && h.toLowerCase() !== 'set-auth-token');
    if (kept.length) headers.set('access-control-expose-headers', kept.join(', '));
    else headers.delete('access-control-expose-headers');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const GET = async (req: Request) => stripAuthTokenHeader(await handlers.GET(req));
export const POST = async (req: Request) => stripAuthTokenHeader(await handlers.POST(req));
```

Test it directly: a Response carrying `set-auth-token` plus an expose-headers list comes back without either trace, and a Response without the header passes through untouched.

- [ ] **Step 3: Make cookie-vs-bearer precedence explicit**

`withBearerAlias`'s comment claims the explicit auth header is the more specific signal, but one layer down the opposite happens: the plugin **appends** its synthesized cookie (`existingCookie + '; ' + newCookie`) and better-call's parser keeps the **first** occurrence of a name. So when a request carries both a session cookie and a token, the cookie silently wins and the token is discarded. A client with a cookie jar acts as the *cookie's* identity while believing it acted as the token's — a wrong-user action, not a failed one.

In `apiAuth()`, when a token header is present, delete `Cookie` before calling `getSession` so the token is unambiguously the credential:

```ts
function withBearerAlias(incoming: Headers): Headers {
  const explicit = incoming.get('authorization');
  const apiKey = incoming.get('x-api-key');
  if (!explicit && !apiKey) return incoming;
  const resolved = new Headers(incoming);
  if (!explicit && apiKey) resolved.set('authorization', `Bearer ${apiKey}`);
  // A presented token is an explicit identity claim. Leaving the cookie
  // attached lets it win silently one layer down, so the caller would act as
  // the cookie's user while believing it acted as the token's.
  resolved.delete('cookie');
  return resolved;
}
```

Add a test asserting that a request carrying BOTH a cookie and a bearer token resolves to the token's user, not the cookie's.

- [ ] **Step 4: Harden the `deviceCode` schema now**

The table stays (unused until the flow returns) so re-enabling needs no schema work — which means the hardening is cheaper now than later. Add unique indexes on `deviceCode` and `userCode`, matching the `session_token_unique` precedent this file already sets for the analogous secret, and a `userId` foreign key to `user.id` with cascade delete, matching `session.userId` and `account.userId` in the same file.

Generate with `pnpm --filter @forge/db db:generate`. Never hand-write it. Grep-verify the new tag appears in `packages/db/migrations/meta/_journal.json` before committing.

- [ ] **Step 5: Document the `requireSignature` trade-off**

For a token with no `.` — exactly the shape of `session.token` — the plugin signs the value itself with the server secret and then verifies its own signature, so that check cannot fail. The DB lookup on `session.token` is the real gate. Setting `requireSignature: true` would reject the raw session tokens the device flow issues, so it cannot be turned on without also changing what the flow returns. Record that in a comment beside `bearer()` so it reads as a considered trade-off rather than an oversight someone will "fix" and break the flow.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
```

---

## Task 3: Schema registry, response helpers, and generated OpenAPI

**Files:**
- Create: `apps/web/src/lib/api/schemas.ts`, `apps/web/src/lib/api/respond.ts`, `apps/web/src/lib/api/respond.test.ts`
- Create: `scripts/generate-openapi.ts`, `docs/api/openapi.json`
- Modify: `package.json` (an `api:spec` script), `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `ok(data, status?)`, `fail(code, message, status)`, and `schemas` — a registry keyed by operation id

- [ ] **Step 1: Write the failing test for the response shape**

Create `apps/web/src/lib/api/respond.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fail, ok } from './respond';

describe('respond', () => {
  it('wraps success data unchanged', async () => {
    const res = ok({ id: 'm1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'm1' });
  });

  it('uses one error shape for every failure', async () => {
    const res = fail('not_found', 'Mission not found', 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Mission not found' } });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — cannot resolve `./respond`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/api/respond.ts`:

```ts
/** One success shape and one error shape across every v1 route. */
export function ok<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Ownership failures use 404, never 403 — a resource's existence must not be
 * observable across accounts. getMission/getTask already return null for both
 * "does not exist" and "not yours", so this keeps the API consistent with the
 * data layer rather than leaking the distinction.
 */
export function notFound(what: string): Response {
  return fail('not_found', `${what} not found`, 404);
}
```

- [ ] **Step 4: Add the schema registry**

`apps/web/src/lib/api/schemas.ts` — one entry per operation. Reuse `createMissionSchema` from `lib/missions.ts` rather than redefining it:

```ts
import { z } from 'zod';
import { createMissionSchema } from '@/lib/missions';

export const schemas = {
  'missions.list': { query: z.object({ status: z.string().optional() }) },
  'missions.create': { body: createMissionSchema },
  'missions.get': { params: z.object({ missionId: z.string() }) },
  'missions.plan': { params: z.object({ missionId: z.string() }) },
  'missions.start': { params: z.object({ missionId: z.string() }) },
  'missions.cancel': { params: z.object({ missionId: z.string() }) },
  'missions.retry': { params: z.object({ missionId: z.string() }) },
  'tasks.list': { params: z.object({ missionId: z.string() }) },
  'tasks.get': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.approve': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.dismiss': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.steer': {
    params: z.object({ missionId: z.string(), taskId: z.string() }),
    body: z.object({ message: z.string().min(1).max(10_000) }),
  },
  'tasks.abort': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'ledger.mission': { params: z.object({ missionId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  'ledger.task': { params: z.object({ missionId: z.string(), taskId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  'repos.list': {},
  'repos.getPolicy': { params: z.object({ repo: z.string() }) },
  'repos.setPolicy': {
    params: z.object({ repo: z.string() }),
    body: z.object({ requirePlanApproval: z.boolean() }),
  },
} as const;
```

- [ ] **Step 5: Generate the spec**

**No new dependency.** Zod 4.3.6 is installed and ships `z.toJSONSchema()` — verified working against the installed copy. Do not add `zod-to-json-schema` or `@asteasolutions/zod-to-openapi`.

**No new runner either.** `tsx` is not installed and the repo has no TypeScript script runner. Rather than adding one, spec generation is a **vitest test** — CI already runs `pnpm -r test`, so an ungenerated schema change fails the build with no CI edit at all. This is the standard snapshot pattern, and it satisfies the spec's "generation runs in CI" requirement more directly than a bespoke script would.

Create `apps/web/src/lib/api/openapi.ts`:

```ts
import { z } from 'zod';
import { schemas } from './schemas';

/**
 * Derives the OpenAPI document from the same Zod schemas the handlers
 * validate with, so the spec cannot drift from the implementation. Hand-
 * authoring it would make drift a matter of discipline; deriving it makes
 * drift structurally impossible.
 */
export function buildOpenApiDocument(): unknown {
  const paths: Record<string, unknown> = {};
  for (const [operationId, def] of Object.entries(schemas)) {
    paths[operationId] = {
      operationId,
      params: def.params ? z.toJSONSchema(def.params) : undefined,
      query: def.query ? z.toJSONSchema(def.query) : undefined,
      body: def.body ? z.toJSONSchema(def.body) : undefined,
    };
  }
  return { openapi: '3.1.0', info: { title: 'Forge API', version: '1.0.0' }, paths };
}
```

Create `apps/web/src/lib/api/openapi.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

// apps/web/src/lib/api → repo root is five levels up. Count carefully: this
// kind of relative chain broke twice on this project when files moved.
const SPEC_PATH = resolve(__dirname, '../../../../../docs/api/openapi.json');

describe('openapi spec', () => {
  it('matches the committed document', () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) {
      writeFileSync(SPEC_PATH, generated);
      return;
    }
    // Fails the build when a schema changed and the spec was not regenerated.
    // Run `pnpm api:spec` to update it.
    expect(generated).toBe(readFileSync(SPEC_PATH, 'utf8'));
  });
});
```

Add to root `package.json`: `"api:spec": "UPDATE_OPENAPI=1 pnpm --filter @forge/web vitest run src/lib/api/openapi.test.ts"`.

Check the actual package name in `apps/web/package.json` and use it verbatim in that script.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm api:spec && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/lib/api docs/api/openapi.json package.json
git commit -m "feat(api): schema registry, one response shape, generated OpenAPI"
```

---

## Task 4: Mission endpoints, and delete the dead ones

**Files:**
- Create: `apps/web/src/app/(app)/api/v1/missions/route.ts` and `.../[missionId]/{route,plan,start,cancel,retry}`
- Create: `apps/web/src/app/(app)/api/v1/missions/route.test.ts`
- Delete: `api/missions/route.ts`, `api/missions/[missionId]/route.ts`, `.../plan`, `.../start`, `.../cancel`, `.../retry`, `.../tasks`

**Interfaces:**
- Consumes: `withApiAuth` (Task 1), `ok`/`fail`/`notFound` and `schemas` (Task 3)
- Produces: the v1 mission routes

- [ ] **Step 1: Write the failing ownership test**

```ts
it('404s a mission owned by another user, without leaking that it exists', async () => {
  await seedMission({ id: 'm_theirs', userId: 'someone_else' });
  const res = await GET(new Request('http://x'), { params: Promise.resolve({ missionId: 'm_theirs' }) });
  expect(res.status).toBe(404);
  const body = await res.json();
  // Identical to a genuinely missing id — existence must not be observable.
  expect(body.error.code).toBe('not_found');
});

it('returns a mission the caller owns', async () => {
  await seedMission({ id: 'm_mine', userId: 'u1' });
  const res = await GET(new Request('http://x'), { params: Promise.resolve({ missionId: 'm_mine' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe('m_mine');
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement one route, then mirror it**

`apps/web/src/app/(app)/api/v1/missions/[missionId]/route.ts`:

```ts
import { withApiAuth } from '@/lib/api/auth';
import { notFound, ok } from '@/lib/api/respond';
import { getMission } from '@/lib/missions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, _req, { params }) => {
    const { missionId } = await params;
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');
    return ok(mission);
  },
);
```

The lifecycle routes follow the same shape, each calling its existing `lib/` function — `runPlanner`, `startMission`, `cancelMission`, `retryMission` — and translating `MissionTransitionError` / `PlannerError` into `fail(code, message, 409)`. Read the routes being deleted for the exact error handling they already do, and preserve it.

- [ ] **Step 4: Delete the six dead routes**

```bash
git rm -r "apps/web/src/app/(app)/api/missions/route.ts" \
  "apps/web/src/app/(app)/api/missions/[missionId]/route.ts" \
  "apps/web/src/app/(app)/api/missions/[missionId]/plan" \
  "apps/web/src/app/(app)/api/missions/[missionId]/start" \
  "apps/web/src/app/(app)/api/missions/[missionId]/cancel" \
  "apps/web/src/app/(app)/api/missions/[missionId]/retry" \
  "apps/web/src/app/(app)/api/missions/[missionId]/tasks"
```

Do **not** delete `retrospect`, `tasks/[taskId]/stream`, or `proposals` — all three have in-app callers.

Then confirm nothing referenced them: `grep -rn "api/missions/" apps/web/src --include="*.tsx" --include="*.ts" | grep -v "/api/v1/"` should show only `retrospect` and `stream`.

- [ ] **Step 5: Run the tests, mutation-test, commit**

Mutations, one at a time with the source printed:
1. Change `getMission(missionId, user.id)` to `getMission(missionId, 'someone_else')` → the ownership test must fail.
2. Change `notFound('Mission')` to a 403 → the leak test must fail.

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add -A "apps/web/src/app/(app)/api"
git commit -m "feat(api): v1 mission endpoints; delete the six uncalled routes"
```

---

## Task 5: Task endpoints — the operator surface

These are the operations that exist today **only** as Server Actions. This is what makes the API operable rather than merely readable.

**Files:**
- Create: `apps/web/src/app/(app)/api/v1/missions/[missionId]/tasks/route.ts` and `.../[taskId]/{route,approve,dismiss,steer,abort}`
- Create: matching `.test.ts` files

**Interfaces:**
- Consumes: `withApiAuth`, `ok`/`fail`/`notFound`, `schemas`
- Produces: the v1 task routes

- [ ] **Step 1: Write the failing tests**

Cover, for each of approve / dismiss / steer / abort: the happy path, and a task owned by another user returning 404 without mutating anything.

```ts
it('approve moves needs_human to ready_to_merge', async () => {
  await seedTask({ id: 't1', missionId: 'm_mine', status: 'needs_human', escalationReason: 'ai_review_rejected' });
  const res = await POST(new Request('http://x', { method: 'POST' }),
    { params: Promise.resolve({ missionId: 'm_mine', taskId: 't1' }) });
  expect(res.status).toBe(200);
  expect((await taskRow('t1')).status).toBe('ready_to_merge');
});

it('404s and writes nothing for another user\'s task', async () => {
  await seedTask({ id: 't_theirs', missionId: 'm_theirs', status: 'needs_human' });
  const res = await POST(new Request('http://x', { method: 'POST' }),
    { params: Promise.resolve({ missionId: 'm_theirs', taskId: 't_theirs' }) });
  expect(res.status).toBe(404);
  expect((await taskRow('t_theirs')).status).toBe('needs_human');
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement, reusing the existing logic**

The Server Actions already hold the correct behaviour — `reviewAction` (approve/dismiss), `steerTask`, `abortTask`. **Do not reimplement it in the routes.** Extract the shared logic into `lib/` first if it is currently inline in the action, then have both the action and the route call it. That is the boundary rule: logic in `lib/`, transports thin.

Note `reviewAction(formData: FormData)` takes FormData because it is a form action. The route should call the extracted `lib/` function directly rather than constructing a FormData to satisfy the action's signature.

Preserve the compare-and-swap: approve/dismiss guard on `status = 'needs_human'`, so a concurrent transition is a safe no-op rather than an overwrite.

- [ ] **Step 4: Verify, mutation-test, commit**

Mutations, per behaviour, source printed each time:
1. Drop the ownership scope from the task lookup → the cross-account test must fail.
2. Remove the `needs_human` precondition → the precondition test must fail.
3. Remove the CAS guard → the concurrent-transition test must fail.

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add -A "apps/web/src/app/(app)/api/v1" apps/web/src/lib
git commit -m "feat(api): v1 task operations — approve, dismiss, steer, abort"
```

---

## Task 6: Ledger endpoints

The highest-value endpoints in the plan. Auditability is the product's headline claim and the ledger is currently reachable only through a browser.

**Files:**
- Create: `apps/web/src/app/(app)/api/v1/missions/[missionId]/ledger/route.ts`
- Create: `apps/web/src/app/(app)/api/v1/missions/[missionId]/tasks/[taskId]/ledger/route.ts`
- Create: matching `.test.ts`

**Interfaces:**
- Consumes: `listLedgerForMission(missionId, limit)` and `listLedgerForTask(taskId, limit)` from `@/lib/ledger`; `withApiAuth`
- Produces: the ledger read endpoints

- [ ] **Step 1: Write the failing test**

```ts
it('returns a mission ledger the caller owns', async () => {
  await seedMission({ id: 'm_mine', userId: 'u1' });
  await seedLedgerEvent({ missionId: 'm_mine', eventType: 'mission.started' });
  const res = await GET(new Request('http://x'), { params: Promise.resolve({ missionId: 'm_mine' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).events[0].eventType).toBe('mission.started');
});

it('404s another user\'s ledger — the audit trail is not cross-readable', async () => {
  await seedMission({ id: 'm_theirs', userId: 'other' });
  await seedLedgerEvent({ missionId: 'm_theirs', eventType: 'mission.started' });
  const res = await GET(new Request('http://x'), { params: Promise.resolve({ missionId: 'm_theirs' }) });
  expect(res.status).toBe(404);
});

it('returns a backend-agnostic shape', async () => {
  // The ledger's value is that events from managed-agents, gateway and gemini
  // normalise to one schema. The response must not leak which engine produced
  // an event beyond the data already stored.
  await seedMission({ id: 'm_mine', userId: 'u1' });
  await seedLedgerEvent({ missionId: 'm_mine', eventType: 'agent.tool_use', sourceEventId: 'sevt_1' });
  const body = await (await GET(new Request('http://x'), { params: Promise.resolve({ missionId: 'm_mine' }) })).json();
  expect(Object.keys(body.events[0]).sort()).toEqual(
    ['createdAt', 'eventType', 'id', 'missionId', 'payload', 'sourceEventId', 'taskId'].sort(),
  );
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

```ts
export const GET = withApiAuth<{ params: Promise<{ missionId: string }> }>(
  async (user, req, { params }) => {
    const { missionId } = await params;
    // Ownership is checked on the MISSION before any ledger row is read —
    // the audit trail must not be cross-readable.
    const mission = await getMission(missionId, user.id);
    if (!mission) return notFound('Mission');
    const limit = schemas['ledger.mission'].query.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    ).limit;
    return ok({ events: await listLedgerForMission(missionId, limit) });
  },
);
```

- [ ] **Step 4: Verify, mutation-test, commit**

1. Remove the ownership check before the ledger read → the cross-account test must fail.
2. Ignore the `limit` query parameter → add a test asserting the cap is honoured, then confirm it fails.

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add -A "apps/web/src/app/(app)/api/v1"
git commit -m "feat(api): ledger read endpoints"
```

---

## Task 7: Repo endpoints and the spec check

**Files:**
- Create: `apps/web/src/app/(app)/api/v1/repos/route.ts`, `.../[owner]/[repo]/policy/route.ts`
- Create: matching `.test.ts`
- Modify: `docs/api/openapi.json` (regenerate)

**Interfaces:**
- Consumes: `getRepoPolicy` from `@/lib/repo-policy`, `updateRepoSettings`'s extracted core, `withApiAuth`
- Produces: the v1 repo routes

- [ ] **Step 1: Write the failing tests**

Cover: listing only the caller's repos; reading a policy; setting `requirePlanApproval`; and a repo the caller has no installation for returning 404 and writing nothing.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

Reuse `getRepoPolicy` for reads. For writes, call the same ownership-checked path `updateRepoSettings` uses — **the repo must be derived from the ownership-checked container's `workspaceRepo`, never from a caller-supplied parameter.** That was hop two of a five-hop cross-account chain closed on 2026-07-27; a route that accepts a repo name and writes policy for it reopens it.

- [ ] **Step 4: Regenerate the spec and verify it is committed**

```bash
pnpm api:spec
git diff --exit-code docs/api/openapi.json || echo "spec regenerated — commit it"
```

- [ ] **Step 5: Verify, mutation-test, commit**

1. Accept the repo from a request parameter instead of the container → the cross-account test must fail.
2. Drop the installation scope from the repo list → the listing test must fail.

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add -A "apps/web/src/app/(app)/api/v1" docs/api/openapi.json
git commit -m "feat(api): v1 repo endpoints and policy"
```

---

## Task 8: The device flow, done properly

Deferred from Task 2b. The API surface is the product; a login flow with nothing to log into has no purpose, so this lands last — but it must land before any CLI ships, and re-registering the plugin without the rest of this task reopens exactly what 2b closed.

**Files:**
- Modify: `apps/web/src/lib/auth.ts` (re-register `deviceAuthorization()` with options)
- Create: `apps/web/src/app/(app)/device/page.tsx` and its action
- Modify: `apps/web/src/server/tick/` (an expiry sweep)

- [ ] **Step 1: The consent page.** `/device` requires an authenticated session, shows the requesting `client_id` and the scope being granted, and requires the human to **type the user code** — the typing is the proof that the person approving is the person who started the flow. Approving must call `device/approve` for that specific code, never for whatever code is pending.

- [ ] **Step 2: `validateClient`.** An allow-list of known client ids. An unknown `client_id` is rejected at `device/code`, before a row is ever created.

- [ ] **Step 3: Scope.** Either enforce it or reject it. Until the API has real scopes, reject any non-empty `scope` with a 400 rather than storing and echoing a restriction nothing reads — an integrator who sees `scope` accepted will reasonably assume it constrains the token.

- [ ] **Step 4: Expiry sweep.** Rows are deleted only when polled after expiry, denied-then-polled, or exchanged. A code created and never polled lives forever, and `device/code` is unauthenticated, so the table grows without bound. Add a sweep to the existing tick pipeline.

- [ ] **Step 5: Rate limiting.** better-auth's limiter keys on the first `X-Forwarded-For` element, which is attacker-supplied behind Cloud Run, and defaults to in-memory storage that does not survive scaling. Add `rateLimit.customRules` for `/device/*` and set `advanced.ipAddress.ipAddressHeaders` to what the real proxy guarantees.

- [ ] **Step 6: Ownership test.** A device code approved by user A must never yield a session for user B, and the test must fail if the `userId` guard is removed.

---

## Final verification

- [ ] `pnpm typecheck && pnpm -r lint && pnpm -r test` clean
- [ ] `pnpm api:spec` produces no diff — the committed spec matches the schemas
- [ ] `grep -rn "api/missions/" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "/api/v1/"` shows only `retrospect` and the SSE `stream`
- [ ] Every v1 route is exported through `withApiAuth` — no route calls `apiAuth()` directly
- [ ] Every mutation listed in Tasks 1–7 was actually run, with the mutated source printed to confirm the edit landed, and reported per behaviour rather than bundled
- [ ] No migration was generated; if one was, its filename appears in `packages/db/migrations/meta/_journal.json`
