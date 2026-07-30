# Forge — Agent Instructions

Read this before doing anything. It tells you where everything is.

## Repo layout

```
apps/web/src/app/api/missions/              API routes (Next.js Route Handlers)
apps/web/src/app/api/missions/[missionId]/  Per-mission routes (start/, plan/, tasks/)
apps/web/src/app/missions/                  Console pages
apps/web/src/lib/                           Business logic (missions.ts, planner.ts, tasks.ts, ledger.ts, mission-transitions.ts)
apps/web/src/components/                    UI components (shadcn + custom)
apps/web/src/server/tick/                   Tick engine (dispatcher.ts, poller.ts, ci.ts, auto-merge.ts, budgets.ts, reconciler.ts, state.ts, tick.ts)
apps/web/src/server/tick/adapters/          Backend adapters (types.ts, managed-agents.ts, gateway.ts)
packages/db/src/schema.ts                   Database schema (ALL tables, enums, types)
packages/db/src/client.ts                   DB client factory
```

## How to add an API endpoint

1. Read `apps/web/src/app/api/missions/[missionId]/start/route.ts` — that's the pattern.
2. If you need a new business function, add it to `apps/web/src/lib/mission-transitions.ts`.
3. Create the route file at `apps/web/src/app/api/missions/[missionId]/<name>/route.ts`.
4. Gate with `apiAuth()` — see existing routes.

## How to add a tick subsystem

1. Read `apps/web/src/server/tick/auto-merge.ts` — that's the pattern.
2. Create `apps/web/src/server/tick/<name>.ts` with a `run<Name>(log)` function.
3. Wire it into `apps/web/src/server/tick/tick.ts` in the right order.

## How to add a DB column

1. Edit `packages/db/src/schema.ts`.
2. Run: `cd packages/db && pnpm db:generate`

## Verify before pushing

```bash
pnpm -r typecheck    # must pass
pnpm -r test         # must pass
```

**If the toolchain is unavailable, push anyway — do not stall.** A sandboxed
run's network is restricted to the git host, so `pnpm`/corepack may be unable
to reach a package registry and these commands will hang in retry loops. Do
not spend your turn working around it: commit your work and push your branch.
CI runs the same checks on the pull request, which is what the gate is for.
Work that is committed but never pushed is lost when the sandbox ends — so
pushing always beats verifying locally.

## Pushing your work

Commit your work, then push it to the branch Forge assigned for this task:

```bash
git push origin HEAD:{{forge_branch}}
```

The exact branch name is given in your task instructions. Push to that name and
no other — Forge opens the pull request from it, and a branch under a different
name is not something Forge will find.

**Do not open a pull request yourself.** The sandbox can reach `github.com` but
not `api.github.com`, so `gh pr create` cannot work. Push the branch and stop;
Forge opens the PR and runs it through CI.

## Commit format

`<type>: <description>` where type is feat/fix/docs/chore/test.

## Important: repo location

The repository is already checked out. It is normally your working directory; if
it is not, run `git rev-parse --show-toplevel` to locate it. Do not assume a
fixed absolute path — the layout differs between hosted and self-hosted
sandboxes, so any path stated here would be wrong half the time.
