# Consolidate apps/tick into apps/web (Next.js 16) — Design

**Status:** Approved (2026-07-19).

## Problem

Forge runs two deployed services against one shared DB (`@forge/db`): `apps/web` (Next.js UI/console) and `apps/tick` (Fastify backend — dispatcher, reconciler, poller, gates, guardrails, ai-review, auto-merge, ci, verify, budgets, memory, skill-loader). Prior investigation into a recurring "why do we need 2 servers" question (this session) found the split isn't accidental complexity, but a follow-up research pass turned up a correctable premise: tick has no continuous background loop. Its entire runtime is Google Cloud Scheduler → OIDC-verified `POST /tick` → one sequential, synchronous pass through all subsystems via `runTick()` (`apps/tick/src/tick.ts:48-130`), then the process goes idle until the next scheduled hit. Grepped confirmed zero `setInterval`/`setTimeout`/loop constructs anywhere in `apps/tick/src`.

Given that, tick is really two thin HTTP routes (`POST /tick`, `GET /tasks/:taskId/stream`) wrapping ~3,400 LOC of framework-agnostic business logic (no Fastify imports outside `server.ts`/`index.ts`), running on its own deploy (Cloud Run, `apps/tick/Dockerfile`), with its own env vars and its own credential surface (`ANTHROPIC_API_KEY`, `GATEWAY_API_KEY`, `GITHUB_APP_TOKEN`, `FORGE_MA_*`). `apps/web` also already terminates external webhooks directly (`api/forge/github/webhook`, `api/forge/webhook/[missionId]`), so tick's only remaining inbound trigger is the scheduler cron. Given Next.js 16 self-hosted (standalone output) runs as a normal persistent Node process with no serverless duration ceiling, there's no structural reason left to keep two services, one deploy pipeline, and one extra network hop (web's SSE stream route today proxies through tick, which proxies to Anthropic) for what is fundamentally one app's worth of logic.

**Explicitly out of scope:** replacing tick's poll-and-recheck model with the Vercel Workflow Dev Kit's durable suspend/resume primitives. That's a different, larger redesign (event-driven waits instead of re-polling every tick) evaluated and rejected for this project — tick's one-shot-per-pass execution model doesn't hold in-memory state to suspend, so the Workflow Dev Kit solves a problem this codebase doesn't have.

## Design

### A. Code structure

All of tick's framework-agnostic source moves verbatim into `apps/web/src/server/tick/`, import paths updated, file contents otherwise unchanged:

`dispatcher.ts`, `reconciler.ts`, `poller.ts`, `gates.ts`, `guardrails.ts`, `ai-review.ts`, `auto-merge.ts`, `ci.ts`, `verify.ts`, `budgets.ts`, `memory.ts`, `skill-loader.ts`, `dag.ts`, `tick.ts`, `state.ts`, `agents-md.ts`, `triage-verdict.ts`, `oidc.ts`, `prompt.ts` — plus their 18 co-located `*.test.ts` files, moved alongside their source files (same directory, same relative naming). `server.test.ts` is the one exception: it tests the Fastify wiring being deleted (see below), so it's deleted rather than moved.

`apps/tick/src/db.ts` and `bootstrap.ts` are dropped (their job — loading `.env.local` before other modules evaluate, and constructing the drizzle client — is already handled by `apps/web`'s existing setup). `apps/tick/src/env.ts` folds into `apps/web/src/lib/env.ts`: every tick env var (`ANTHROPIC_API_KEY` already exists there; add `ANTHROPIC_BASE_URL`, `GATEWAY_API_KEY`, `GATEWAY_ENVIRONMENT_ID`, `FORGE_MA_ENVIRONMENT_ID`, `FORGE_MA_DEFAULT_VAULT_ID`, `TASK_RETRY_MAX`, `TASK_MAX_TURNS`, `TASK_NO_PROGRESS_TOKENS`, `TASK_MAX_TOKENS`, `BUDGET_HARD_STOP_PCT`, `VERIFY_RETRY_MAX`, `VERIFY_MODEL`, `GATE_STALL_MS`, `TICK_EXPECTED_AUDIENCE`, `TICK_EXPECTED_ISSUER_EMAIL`, `TICK_ALLOW_UNAUTHENTICATED`) becomes a new getter on the existing `env` object, following the file's established `required()`/`optional()` accessor pattern. `GITHUB_APP_TOKEN` already exists in `apps/web/src/lib/env.ts` — no duplicate getter.

`apps/tick/src/server.ts` and `index.ts` (Fastify wiring, process bootstrap, signal handlers) are deleted outright; their 3 routes are re-homed per section B, and there is no standalone process left to bootstrap or signal-handle — `next start` owns the process lifecycle.

Once the migration is verified in deploy (see Rollout), `apps/tick/` (directory, `package.json`, `Dockerfile`) and its Cloud Run service are deleted, and it is removed from `pnpm-workspace.yaml` / root `package.json`'s workspace list.

### B. Routes & auth

- **`POST /tick`** → new `apps/web/src/app/api/tick/route.ts`. Carries over `oidc.ts`'s verification logic unchanged (validates Cloud Scheduler's OIDC token against `TICK_EXPECTED_AUDIENCE`/`TICK_EXPECTED_ISSUER_EMAIL`, with `TICK_ALLOW_UNAUTHENTICATED` for local dev), then calls the moved `runTick()`.
- **`GET /tasks/:taskId/stream`** → the existing `apps/web/src/app/(app)/api/tasks/[taskId]/stream/route.ts` is rewritten to call the Anthropic/Managed-Agents streaming API directly in-process (using the now-local `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`), instead of fetching `env.TICK_INTERNAL_URL/tasks/:taskId/stream` and relaying. The existing 404→503 remap (so `EventSource` keeps retrying instead of giving up on a task that's real but not yet dispatched) is preserved, adapted to whatever not-found signal the direct call produces. `env.TICK_INTERNAL_URL` is deleted from `apps/web/src/lib/env.ts` once this route no longer uses it.
- **`GET /healthz`** → not recreated separately; `apps/web`'s existing `api/health/route.ts` already serves this role for the merged process.
- **Manual tick trigger** (`apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts:284-297`, wired to `repo-toolbar.tsx`'s `handleManualTick`) currently does `fetch(`${env.TICK_INTERNAL_URL}/tick`, { method: 'POST' })`. It becomes a direct call to the moved `runTick()` — the function's `try`/`catch` collapses to just whatever errors `runTick()` itself can throw (there is no longer a network hop to fail independently of that).

### C. Credentials & deploy

Concrete consequence of the merge, stated plainly: today, `ANTHROPIC_API_KEY`/`GATEWAY_API_KEY`/`GITHUB_APP_TOKEN` live only in tick's process — the existing code comment on the stream route says this outright ("Tick holds all Managed Agents credentials — this route never sees them"). Post-merge, the single Next.js process holds all of it, so any web route handler's bug now executes in the same process as these credentials, and a hard crash in dispatcher/reconciler code takes down the UI-serving process too, until Cloud Run restarts it. This was evaluated and accepted rather than mitigated with process isolation (e.g. a child process or worker thread for tick's work) — the added complexity isn't justified given tick's existing per-subsystem `try`/`catch` in `runTick()` already isolates failures within a single pass, and outright process crashes are not the common failure mode being guarded against.

Deploy becomes a single `apps/web/Dockerfile` (already exists) building one Next.js 16 standalone-output image, one Cloud Run service. Cloud Scheduler's job target URL is repointed from tick's service URL to `<web-service-url>/api/tick`; the OIDC audience/issuer config Cloud Scheduler already uses for the call doesn't change in kind, only in target.

### D. Testing & rollout

`apps/web`'s vitest config is extended to pick up `src/server/tick/**/*.test.ts` alongside its existing test globs (both projects already share `@forge/db` as a dependency, so no new path-alias work is expected — confirm during implementation that tick's tests don't rely on any Fastify-specific test harness beyond `server.test.ts`, which is deleted along with `server.ts`).

Rollout is a single cutover, not a phased/dual-run migration (consistent with the "accept the risk" decision in section C — there is no interim state where both old and new coexist):

1. Merge the code per sections A/B, `pnpm typecheck` and `pnpm test` clean across the whole workspace.
2. Deploy the merged `apps/web` to its existing Cloud Run service.
3. Repoint Cloud Scheduler's job at `<web-service-url>/api/tick`.
4. Confirm one full `/tick` pass succeeds against production data (checked via logs/DB state, not just a 200 response).
5. Delete `apps/tick/` and its Cloud Run service, remove it from the pnpm workspace.

## Acceptance

- `apps/tick` directory, `package.json`, and `Dockerfile` no longer exist; it's removed from `pnpm-workspace.yaml`.
- `POST /api/tick` on the merged `apps/web` app performs an OIDC-verified tick pass equivalent to today's `POST /tick` on tick's service (same subsystems run, in the same order, with the same per-subsystem failure isolation).
- `GET /api/tasks/:taskId/stream` streams task output without any hop through a separate tick service; the 404-vs-not-yet-dispatched retry behavior for `EventSource` clients is unchanged.
- The manual "trigger tick now" UI action runs a tick pass in-process, with no `TICK_INTERNAL_URL` reference left anywhere in `apps/web`.
- `pnpm typecheck` and `pnpm test` pass across the whole workspace, including the 18 moved test files running under `apps/web`'s vitest config.
- Cloud Scheduler successfully triggers a real tick pass against the merged, deployed `apps/web` service before `apps/tick`'s own service is torn down.
