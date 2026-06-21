# Contributing to Forge

Thanks for your interest. Forge is early — the most useful contributions right now are:

- Trying it on a real fleet and reporting what breaks.
- Sharp issues with repro steps.
- PRs against open issues (please comment first so we don't duplicate work).

## Dev setup

Requires Node 22 and pnpm 10.

```bash
pnpm install

# Env files (fill in secrets afterwards)
cp apps/web/.env.example apps/web/.env.local
cp apps/tick/.env.example apps/tick/.env.local

# Generate and apply the initial DB migration (tick crashes without this)
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate

pnpm dev   # forge-web on :3100, forge-tick on :8080
```

See the README's quickstart for more detail.

## Before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Commit style

Conventional-ish: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Keep subjects under 72 chars.

## Code of conduct

Be decent. Disagree on the work, not the person.
