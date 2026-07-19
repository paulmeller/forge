# Consolidate apps/tick into apps/web (Next.js 16) — Design

**Status:** Approved (2026-07-19). Revised twice same day after adversarial code-grounded reviews: round one caught an incomplete file inventory, a missing logger/dependency story, and an orphaned startup call; round two confirmed those fixes and added the test-file migrations-path fix, GitHub-workflow updates, and the explicit `withAuth()` retention on the stream route.

## Problem

Forge runs two deployed services against one shared DB (`@forge/db`): `apps/web` (Next.js UI/console) and `apps/tick` (Fastify backend — dispatcher, reconciler, poller, gates, guardrails, ai-review, auto-merge, ci, verify, budgets, memory, skill-loader). Prior investigation into a recurring "why do we need 2 servers" question (this session) found the split isn't accidental complexity, but a follow-up research pass turned up a correctable premise: tick has no continuous background loop. Its entire runtime is Google Cloud Scheduler → OIDC-verified `POST /tick` → one sequential, synchronous pass through all subsystems via `runTick()` (`apps/tick/src/tick.ts:48-130`), then the process goes idle until the next scheduled hit. Grep confirmed zero `setInterval`/`setTimeout`/loop constructs anywhere in `apps/tick/src` (including `adapters/`).

Given that, tick is really two thin HTTP routes (`POST /tick`, `GET /tasks/:taskId/stream`) wrapping ~3,700 LOC of framework-agnostic business logic, running on its own deploy (Cloud Run, `apps/tick/Dockerfile`), with its own env vars and its own credential surface (`ANTHROPIC_API_KEY`, `GATEWAY_API_KEY`, `GITHUB_APP_TOKEN`, `FORGE_MA_*`). `apps/web` also already terminates external webhooks directly (`api/forge/github/webhook`, `api/forge/webhook/[missionId]`), so tick's only remaining inbound trigger is the scheduler cron. Given Next.js 16 self-hosted (standalone output — already configured in `apps/web/next.config.mjs`) runs as a normal persistent Node process with no serverless duration ceiling, there's no structural reason left to keep two services, one extra deploy pipeline, and one extra network hop for what is fundamentally one app's worth of logic.

"Framework-agnostic" has one caveat the original draft missed: `apps/tick/src/tick.ts:1` imports `FastifyBaseLogger` as the type of `runTick()`'s logger parameter. The subsystems themselves declare minimal structural `Logger` types (e.g. `dispatcher.ts:34-38` with `info`/`warn`/`error`; `ai-review.ts:13-16` an `info`/`warn` subset) and are genuinely portable; `tick.ts` needs a one-line type change (section A).

**Explicitly out of scope:** replacing tick's poll-and-recheck model with the Vercel Workflow Dev Kit's durable suspend/resume primitives. That's a different, larger redesign (event-driven waits instead of re-polling every tick) evaluated and rejected for this project — tick's one-shot-per-pass execution model doesn't hold in-memory state to suspend, so the Workflow Dev Kit solves a problem this codebase doesn't have.

## Design

### A. Code structure

All of tick's business-logic source moves into `apps/web/src/server/tick/`, import paths updated, contents otherwise unchanged except where noted:

`dispatcher.ts`, `reconciler.ts`, `poller.ts`, `gates.ts`, `guardrails.ts`, `ai-review.ts`, `auto-merge.ts`, `ci.ts`, `verify.ts`, `budgets.ts`, `memory.ts`, `skill-loader.ts`, `dag.ts`, `tick.ts`, `state.ts`, `agents-md.ts`, `triage-verdict.ts`, `oidc.ts`, `prompt.ts`, **and the whole `adapters/` directory** (`adapters/index.ts`, `adapters/types.ts`, `adapters/managed-agents.ts`, `adapters/gateway.ts`) — nine of the listed files import `./adapters`, so it moves as a unit. With it come the 20 co-located `*.test.ts` files (18 top-level + `adapters/adapter-contract.test.ts` + `adapters/managed-agents.test.ts`), moved alongside their source files. `server.test.ts` is the one exception: it tests the Fastify wiring being deleted, so it's deleted rather than moved.

**Deliberate changes during the move (the only ones):**

- `tick.ts` drops `import type { FastifyBaseLogger } from 'fastify'` and types `runTick()`'s `log` parameter with a local structural `Logger` type (`info`/`warn`/`error` taking `(object, string?)` — the same shape the subsystems already declare). Callers pass a pino logger (below).
- `skill-loader.ts`'s `SKILLS_DIR` (`skill-loader.ts:46-49`, currently `resolve(__dirname, '../../../skills')`) is `__dirname`-relative and breaks both at the new location and under Next standalone bundling (where `import.meta.url` points into `.next/server` chunks). It changes to read `env.FORGE_SKILLS_DIR`, defaulting to `resolve(process.cwd(), '../../skills')` for monorepo dev (cwd is `apps/web` for both `next dev` and vitest); the production image copies the repo-root `skills/` directory in and sets `FORGE_SKILLS_DIR` explicitly.
- Same `__dirname` bug class exists in two moved tests: `reconciler.test.ts:86` and `reconciler.integration.test.ts:32` hardcode `migrationsFolder: resolve(__dirname, '../../../packages/db/migrations')`, which from `apps/web/src/server/tick/` resolves two levels short. The relative path updates to `'../../../../../packages/db/migrations'` in both.

`apps/tick/src/db.ts` is dropped — `apps/web/src/lib/db.ts` already exports the identical `{ db, client }` pair from the same `createDatabase`. `apps/tick/src/bootstrap.ts` is also dropped, with one documented behavior change: bootstrap deliberately loads `.env.local` with dotenv `override: true` so file values beat stale shell vars; Next's built-in `.env.local` loading does **not** override existing shell vars. We accept Next's semantics (a dev-only footgun: a stale exported shell var can shadow `.env.local` — noted here so it's a known quantity, not a mystery).

`apps/tick/src/env.ts` folds into `apps/web/src/lib/env.ts` as new getters on the existing `env` object: `ANTHROPIC_BASE_URL`, `GATEWAY_API_KEY`, `GATEWAY_ENVIRONMENT_ID`, `FORGE_MA_ENVIRONMENT_ID`, `FORGE_MA_DEFAULT_VAULT_ID`, `TASK_RETRY_MAX`, `TASK_MAX_TURNS`, `TASK_NO_PROGRESS_TOKENS`, `TASK_MAX_TOKENS`, `BUDGET_HARD_STOP_PCT`, `VERIFY_RETRY_MAX`, `VERIFY_MODEL`, `GATE_STALL_MS`, `TICK_EXPECTED_AUDIENCE`, `TICK_EXPECTED_ISSUER_EMAIL`, `TICK_ALLOW_UNAUTHENTICATED`, `LOG_LEVEL`, plus the new `FORGE_SKILLS_DIR`. Numeric and boolean vars keep tick's coercions (`Number(x ?? default)`, `=== 'true'`) inside their getters — web's bare `required()`/`optional()` string helpers aren't sufficient alone. `ANTHROPIC_API_KEY`, `GATEWAY_URL`, and `GITHUB_APP_TOKEN` already exist in web's env — no duplicates. `DATABASE_URL`/`DATABASE_AUTH_TOKEN`/`PORT` are moot (web has its own).

**Dependencies:** `apps/web/package.json` gains `@octokit/rest`, `jose`, `yaml`, and `pino` (all currently only in `apps/tick/package.json`). `fastify`/`@fastify/sensible` are not carried over.

**Startup sync re-homed:** `syncSkillsToDb()`'s only call site today is `apps/tick/src/index.ts:17` (once per process boot, non-fatal on failure) — and `index.ts` is deleted. The call moves to a new `apps/web/src/instrumentation.ts` `register()` hook (Node runtime only), preserving the once-per-boot semantics and the non-fatal try/catch. Per index.ts's own comment, the dispatcher resolves built-in triage skills by slug from this table, so this call must not be silently lost.

`apps/tick/src/server.ts` and `index.ts` (Fastify wiring, process bootstrap, signal handlers) are deleted outright; their 3 routes are re-homed per section B, and `next start` owns the process lifecycle.

Once the migration is verified in deploy (see Rollout), `apps/tick/` (directory, `package.json`, `Dockerfile`) and its Cloud Run service are deleted. Workspace membership comes from `pnpm-workspace.yaml`'s `apps/*` glob, so deleting the directory removes it — no manifest edit needed, and no root script names tick.

### B. Routes & auth

- **`POST /tick`** → new `apps/web/src/app/api/tick/route.ts`. Carries over `oidc.ts`'s verification logic unchanged (validates Cloud Scheduler's OIDC token against `TICK_EXPECTED_AUDIENCE`/`TICK_EXPECTED_ISSUER_EMAIL`, with `TICK_ALLOW_UNAUTHENTICATED` for local dev), constructs a pino logger (level from `env.LOG_LEVEL` — replacing today's `request.log`), and calls the moved `runTick()` with it.
- **`GET /tasks/:taskId/stream`** → the existing `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts` is rewritten to do in-process what tick's route does today (`server.ts:44-85`): a local DB lookup on the `tasks` table (404 when the task doesn't exist **or** exists without a `sessionId` yet — both 404s originate from this lookup, not from upstream), then a raw `fetch` to `${ANTHROPIC_BASE_URL}/v1/sessions/{sessionId}/events/stream` with the `managed-agents-2026-04-01` beta header, relaying the body as SSE. **The web route's existing `withAuth()` guard is retained** — tick's route had no auth because it was network-internal, but the merged route is browser-facing and now sits directly in front of a raw `x-api-key` Anthropic call, so "exactly what tick does" explicitly does not extend to its lack of authentication. The 404→503 remap (so `EventSource` keeps retrying a real-but-not-yet-dispatched task) is preserved, now applied to its own DB-lookup result. `env.TICK_INTERNAL_URL` is deleted from `apps/web/src/lib/env.ts`.
- **`GET /healthz`** → not recreated separately; `apps/web`'s existing `api/health/route.ts` already serves this role for the merged process.
- **Manual tick trigger** (`apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts:285-300`) currently does `fetch(`${env.TICK_INTERNAL_URL}/tick`, { method: 'POST' })`. It becomes a direct call to the moved `runTick()` (with the same pino logger construction) — the network-hop error handling collapses to whatever `runTick()` itself can throw.

### C. Credentials & deploy

Concrete consequence of the merge, stated plainly: today, `ANTHROPIC_API_KEY`/`GATEWAY_API_KEY`/`GITHUB_APP_TOKEN` live only in tick's process — the existing code comment on the stream route says this outright ("Tick holds all Managed Agents credentials — this route never sees them"). Post-merge, the single Next.js process holds all of it, so any web route handler's bug now executes in the same process as these credentials, and a hard crash in dispatcher/reconciler code takes down the UI-serving process too, until Cloud Run restarts it. This was evaluated and accepted rather than mitigated with process isolation (e.g. a child process or worker thread for tick's work) — the added complexity isn't justified given tick's existing per-subsystem `try`/`catch` in `runTick()` already isolates failures within a single pass, and outright process crashes are not the common failure mode being guarded against.

Deploy becomes a single `apps/web/Dockerfile` building one Next.js standalone-output image (adding the repo-root `skills/` directory to the image with `FORGE_SKILLS_DIR` pointing at it), one Cloud Run service. Cloud Scheduler's job target URL is repointed from tick's service URL to `<web-service-url>/api/tick`; the OIDC audience/issuer config Cloud Scheduler already uses doesn't change in kind, only in target.

### D. Testing & rollout

`apps/web/vitest.config.ts` declares no `include` globs, so vitest's defaults already pick up `src/server/tick/**/*.test.ts` — no config change is expected. Web's `vitest.setup.ts` already stubs `DATABASE_URL`, covering what tick's own setup provided (tick's `PORT` stub becomes moot). Tick's remaining tests have no Fastify dependency once `server.test.ts` is deleted, and both projects already share `@forge/db`.

Rollout is a single cutover, not a phased/dual-run migration (consistent with the "accept the risk" decision in section C):

1. Upgrade `apps/web` to Next.js 16 (`^16.2`, with `eslint-config-next` bumped to match) first, as its own commit — verify build, standalone output, and existing routes before any tick code moves. (The spec's premise assumes Next 16 self-hosting; web currently pins `^15.1.0`, so this is an explicit step, not an assumption.)
2. Merge the code per sections A/B; `pnpm typecheck` and `pnpm test` clean across the whole workspace.
3. Update the GitHub workflows: `.github/workflows/ci.yml:56` and `.github/workflows/deploy.yml:127` both build `apps/tick/Dockerfile` — drop the tick image from both so only the web image is built and deployed.
4. Deploy the merged `apps/web` to its existing Cloud Run service.
5. Repoint Cloud Scheduler's job at `<web-service-url>/api/tick`.
6. Confirm one full `/tick` pass succeeds against production data (checked via logs/DB state, not just a 200 response), and that skills synced at boot (step relies on `instrumentation.ts` — verify via its log line).
7. Delete `apps/tick/` and its Cloud Run service, and update the getting-started copy at `apps/web/src/app/(marketing)/page.tsx:137`, which still tells users to `cp apps/tick/.env.example`.

## Acceptance

- `apps/tick` no longer exists (directory deletion alone removes it from the `apps/*` workspace glob); no GitHub workflow, doc, or marketing copy references it.
- `apps/web` is on Next.js 16, building with standalone output.
- `POST /api/tick` on the merged app performs an OIDC-verified tick pass equivalent to today's `POST /tick` (same subsystems, same order, same per-subsystem failure isolation), logging via pino at `LOG_LEVEL`.
- `GET /api/tasks/:taskId/stream` streams task output with no hop through a separate service; the 404-vs-not-yet-dispatched retry behavior for `EventSource` clients is unchanged, with the task/sessionId lookup now performed in-process.
- Skills from the repo-root `skills/` directory sync to the DB at boot via `instrumentation.ts` (verified by its log line), and `FORGE_SKILLS_DIR` resolves correctly both in dev and in the deployed image.
- The manual "trigger tick now" UI action runs a tick pass in-process; no `TICK_INTERNAL_URL` reference remains anywhere in `apps/web`.
- `pnpm typecheck` and `pnpm test` pass across the whole workspace, including the 20 moved test files (incl. both `adapters/` tests) running under `apps/web`'s vitest config.
- Cloud Scheduler successfully triggers a real tick pass against the merged, deployed service before `apps/tick`'s own service is torn down.
