---
name: forge-dev
description: Develop features and fixes in the Forge codebase
version: "1"
allowedTools: [bash, read, edit, write, glob, grep]
loopPolicy:
  maxTurns: 40
  noProgressTokens: 300000
  selfVerify: false
  acceptanceCriteria: |
    - The change implements the requested feature or fix.
    - pnpm -r typecheck and pnpm -r test pass.
    - Changes follow the repo conventions in AGENTS.md.
---

# Forge codebase

Monorepo with pnpm workspaces:

```
apps/web/          Next.js 15 (App Router) — Console + API + webhook receiver
apps/tick/         Fastify — tick loop (dispatcher, poller, CI, auto-merge, budgets, reconciler)
packages/db/       Drizzle ORM + libSQL schema, migrations, client factory
skills/            Curated skill library (SKILL.md per skill)
spikes/            One-off probes and operator utilities
docs/              PRD, audit notes, API gap docs
```

## Key files

- Schema: `packages/db/src/schema.ts` — all tables, enums, types
- Migrations: `packages/db/migrations/` — generate with `pnpm --filter @forge/db db:generate`
- State machine: `apps/tick/src/state.ts` — pure `transition(status, event) → delta`
- Adapters: `apps/tick/src/adapters/` — BackendAdapter interface, MA + Gateway impls
- Tick orchestration: `apps/tick/src/tick.ts` — runTick calls poller → ci → autoMerge → budgets → reconciler → dispatcher
- API routes: `apps/web/src/app/api/`
- Console pages: `apps/web/src/app/missions/`
- Components: `apps/web/src/components/` — shadcn + custom (ProgressPill, Timeline, TaskCard, etc.)
- Auth: `apps/web/src/lib/auth.ts` — better-auth with Drizzle adapter
- Env (web): `apps/web/src/lib/env.ts` — lazy getters
- Env (tick): `apps/tick/src/env.ts` — eager, loaded via dotenv in `src/bootstrap.ts`

## Protocol

1. Read the issue/task description carefully.
2. Find the relevant files with `grep` and `glob`.
3. Make the changes with `edit` (prefer edit over write for existing files).
4. If you add a new DB column: edit `packages/db/src/schema.ts`, then run `pnpm --filter @forge/db db:generate`.
5. Run `pnpm -r typecheck` to verify types.
6. Run `pnpm -r test` to verify tests pass.
7. If typecheck or tests fail, fix until they pass.
8. Commit: `git add -A && git commit -m "<type>: <description>"` where type is feat/fix/docs/chore/test.
9. Push: `git push origin HEAD`.

## Rules

- Always typecheck + test before pushing. Never skip.
- Use Drizzle ORM patterns from existing code — never raw SQL in app code.
- Follow existing naming conventions (camelCase for TS, snake_case for DB columns).
- Don't add dependencies without checking if an existing one covers the need.
- Don't refactor code you're not changing.
- Keep changes minimal and focused on the task.
- If unsure about architecture, read the PRD at `docs/forge-prd.md`.
