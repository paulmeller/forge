# Forge — Agent Instructions

Read this before doing anything. It tells you where everything is.

## Repo layout

```
apps/web/src/app/api/missions/              API routes (Next.js Route Handlers)
apps/web/src/app/api/missions/[missionId]/  Per-mission routes (start/, plan/, tasks/)
apps/web/src/app/missions/                  Console pages
apps/web/src/lib/                           Business logic (missions.ts, planner.ts, tasks.ts, ledger.ts, mission-transitions.ts)
apps/web/src/components/                    UI components (shadcn + custom)
apps/tick/src/                              Tick service (dispatcher.ts, poller.ts, ci.ts, auto-merge.ts, budgets.ts, reconciler.ts, state.ts)
apps/tick/src/adapters/                     Backend adapters (types.ts, managed-agents.ts, gateway.ts)
packages/db/src/schema.ts                   Database schema (ALL tables, enums, types)
packages/db/src/client.ts                   DB client factory
```

## How to add an API endpoint

1. Read `apps/web/src/app/api/missions/[missionId]/start/route.ts` — that's the pattern.
2. If you need a new business function, add it to `apps/web/src/lib/mission-transitions.ts`.
3. Create the route file at `apps/web/src/app/api/missions/[missionId]/<name>/route.ts`.
4. Gate with `apiAuth()` — see existing routes.

## How to add a tick subsystem

1. Read `apps/tick/src/auto-merge.ts` — that's the pattern.
2. Create `apps/tick/src/<name>.ts` with a `run<Name>(log)` function.
3. Wire it into `apps/tick/src/tick.ts` in the right order.

## How to add a DB column

1. Edit `packages/db/src/schema.ts`.
2. Run: `cd packages/db && pnpm db:generate`

## Verify before pushing

```bash
pnpm -r typecheck    # must pass
pnpm -r test         # must pass
```

## Commit format

`<type>: <description>` where type is feat/fix/docs/chore/test.

## Important: repo location

If you're on AgentStep/Sprites, the repo is at `/mnt/session/resources/repo_0`. cd there first.
