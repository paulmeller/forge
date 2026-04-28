# Forge — Agent Context

## Project structure

Monorepo managed by pnpm workspaces:

- `packages/db` — Drizzle ORM schema + migrations for libSQL/Turso. Source of truth for all types.
- `apps/tick` — Fastify service invoked by Cloud Scheduler every 60s. Runs: poller, CI poller, AI review, auto-merge, budgets, reconciler, dispatcher, memory expiry.
- `apps/web` — Next.js App Router console + REST API + better-auth authentication.
- `skills/` — Curated skill definitions (SKILL.md + tools.json per skill).
- `prompts/` — System prompts for retrospective and other agent sessions.

## Tech stack

- **Runtime:** Node 22, TypeScript strict everywhere
- **DB:** Drizzle ORM over libSQL (local SQLite for dev, Turso for prod)
- **Tick service:** Fastify, no framework beyond that
- **Web:** Next.js 15 App Router, Tailwind CSS, shadcn/ui components
- **Auth:** better-auth with email+password
- **Testing:** vitest, no mocking frameworks — extract pure functions and test those
- **Package manager:** pnpm with workspace protocol

## Conventions

- Conventional commits: `feat(scope):`, `fix(scope):`, `test(scope):`, `docs:`
- One feature per PR. Keep PRs focused.
- All exports from `packages/db` are re-exported via `src/index.ts`.
- Tick subsystems are independent async functions that receive a logger and return a typed result.
- Web API routes use `apiAuth()` for authentication (returns 401 tuple).
- Server components use `withAuth()` (redirects to /login).
- Tasks use vitest with `vitest.setup.ts` that stubs env vars. Tests exercise pure/exported functions — no DB mocking.

## Testing

- Run: `pnpm --filter tick test` and `pnpm --filter web test`
- Typecheck: `pnpm --filter <pkg> typecheck`
- Extract pure functions for testability rather than mocking dependencies.
- Test files live next to source: `foo.ts` → `foo.test.ts`

## Key patterns

- **Tick loop** (`apps/tick/src/tick.ts`): ordered subsystems, each wrapped in `.catch()` so one crash doesn't cascade.
- **Ledger events**: every state change inserts a `ledgerEvents` row. Events are the audit trail.
- **Adapter pattern** (`apps/tick/src/adapters/`): `BackendAdapter` interface with MA and Gateway implementations.
- **Status-driven queries**: each subsystem queries tasks by status. Adding a new status means updating INFLIGHT_STATUSES, ALL_TASK_STATUSES, and the task-status-badge component.
