# Forge

**A software factory for Claude Managed Agents: describe work once, get reviewed pull requests back.**

Forge turns Anthropic's Managed Agents into a governed fleet of coding agents. Describe work as a **Mission** ("fix this issue", "bump fast-glob across 140 repos", "add OTel spans to every HTTP handler"); Forge plans it into parallel Tasks, dispatches each to an agent session, has the agent commit to a branch Forge names, opens the PR itself, gates on CI, self-verification and AI review, and merges only what earns it. Every action lands in an append-only Ledger, under per-Mission budgets.

The thing Forge actually sells is the **governance layer**: an agent that can push code is only useful if something decides when its work is good enough to merge, stops it when it burns money going nowhere, and leaves a record of why each change did or didn't land.

Full product spec: [`docs/forge-prd.md`](docs/forge-prd.md) · Architecture writeup: [`docs/blog/forge-architecture.md`](docs/blog/forge-architecture.md).

---

## Status

**Early, but working end to end — and dogfooded.** Forge runs against its own repository: issues get filed, dispatched to agents, gated, and merged as PRs by the same pipeline described here. Recent example: issue #95 (an audit-log durability bug) was filed, fixed by an agent, gated, and merged in one morning for roughly $2 in tokens.

It is young software. Auto-merge is **off by default** and every gate is on; review what agents ship before you turn that off.

## How it works

One idempotent function — the **tick** — runs every 60 seconds over durable database state. No queue, no workers:

```
poller → onboarding → guardrails → ci → verify → ai-review → auto-merge
       → budgets → reconciler → dispatcher → memory → device-codes
```

Each stage is error-isolated and returns a structured result. Every state change is a compare-and-swap on the status the stage observed, and every side effect (sending a turn, opening a PR) is claimed in the database *before* it happens — so a crashed tick repeats no work.

**The completion contract:** Forge assigns each Task the branch `forge/<taskId>`. The agent commits and pushes there; Forge opens the PR. Finding an agent's work is a lookup, never a search — and before Forge ever abandons a Task, it asks GitHub whether that branch exists, because work that exists outranks any inference that it doesn't.

## Architecture

A single self-hosted Next.js app, **`forge-web`**, backed by one libSQL/Turso database. It hosts the Console, the public API, the HMAC-verified webhook receiver, and the tick engine (`apps/web/src/server/tick/`). The tick runs whenever something POSTs to `/api/tick` — Cloud Scheduler with OIDC in production, a button or curl locally. Nothing is vendor-exclusive; the same container runs anywhere that hosts a Node process.

Execution backends sit behind one 8-method adapter (`apps/web/src/server/tick/adapters/`): **Managed Agents** is the primary backend, and the adapter is a plain CMA client, so it works against Anthropic's hosted API or any CMA-compatible engine.

```
forge/
├── apps/web/          # Console + API + webhook receiver + tick engine
├── packages/db/       # Drizzle schema + libSQL client
├── skills/            # Agent skills (bug-fix, etc.)
└── docs/              # PRD, architecture, design specs
```

## Requirements

- Node 22 (`.nvmrc` pins it), pnpm 10
- An Anthropic API key with Managed Agents access
- A GitHub App (for cloning, pushing, opening PRs) — setup below

## Quickstart

### 1. Install and start

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
# edit .env.local — at minimum ANTHROPIC_API_KEY and BETTER_AUTH_SECRET

pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate
pnpm dev
```

Smoke-test that it's up:

```bash
curl -s http://localhost:3100/api/healthz     # → {"status":"ok","service":"forge-web"}
```

Sign in at [http://localhost:3100](http://localhost:3100).

### 2. Connect GitHub

Create a GitHub App (Settings → Developer settings → GitHub Apps) with repository permissions **Contents: Read & write**, **Pull requests: Read & write**, **Issues: Read & write**, **Checks: Read**, and subscribe it to the `issue_comment`, `pull_request`, and `check_suite` events. Point its webhook at `<your-url>/api/forge/github/webhook`.

Put the App id, private key, slug and webhook secret in `.env.local`, then install the App on the repositories you want Forge to work in and complete the connection on the Console's **Setup** page.

### 3. Create the agent

Forge dispatches to an agent record on your Managed Agents backend. Create one whose system prompt tells it to **commit its work and push to the branch Forge names, and never open pull requests itself** — Forge opens them. (Forge validates this at dispatch and records a `dispatch.contract_warning` when an agent's instructions contradict the contract.) Put its id in `FORGE_DEFAULT_AGENT_ID`, and the id of the vault holding its GitHub credential in `FORGE_DEFAULT_GITHUB_VAULT_ID`.

**Verify your configuration before dispatching anything.** Stale or wrong ids here fail *after* dispatch, as a Task that dies before the agent ever runs — the most confusing failure mode there is:

```bash
# Against hosted CMA (or your own CMA-compatible engine's base URL):
curl -s https://api.anthropic.com/v1/agents/$FORGE_DEFAULT_AGENT_ID \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | head -5
```

If that 404s, the id is wrong — fix it before continuing. A Task that fails with **zero tokens spent** almost always means a configuration problem, not an agent problem.

### 4. Onboard a repository

Forge will not touch a repository until that repository consents. On first sight of a repo, Forge opens a small pull request adding `.forge/policy.yml`:

```yaml
gates:
  ci: true          # never merge without CI green
  selfVerify: true  # check the change against its acceptance criteria
  aiReview: true    # independent review of the diff

autoMerge:
  enabled: false    # every change waits for a human. Turn on deliberately.
```

**Merging that PR is the consent** — there is no second switch. Delete the file later and the repository is gated again. The file is the whole policy: while it exists, it wins over anything set in the Console.

### 5. Run work

From the Console, pick an issue and choose **Work on this**, or comment `@forge fix this` on a GitHub issue (only repository owners, members and collaborators can command an agent this way). Then drive the tick:

```bash
curl -X POST http://localhost:3100/api/tick   # needs TICK_ALLOW_UNAUTHENTICATED=true locally
```

Nothing advances without a tick. Loop it every 45–60 seconds and watch the Task move through dispatch → running → PR → gates. In production, Cloud Scheduler does this.

## Configuration

The essentials (see [`apps/web/.env.example`](apps/web/.env.example) for the full list):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | libSQL/Turso URL, or `file:./local.db` |
| `BETTER_AUTH_SECRET` | Session signing secret (32+ random chars) |
| `ANTHROPIC_API_KEY` | Managed Agents + Console chat |
| `ANTHROPIC_BASE_URL` | Point at a CMA-compatible engine instead of Anthropic |
| `FORGE_DEFAULT_AGENT_ID` | The agent record Missions dispatch to |
| `FORGE_DEFAULT_GITHUB_VAULT_ID` | Vault holding the agent's GitHub credential |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` | GitHub App identity |
| `TICK_EXPECTED_AUDIENCE` / `TICK_EXPECTED_ISSUER_EMAIL` | OIDC verification for the production tick |
| `TICK_ALLOW_UNAUTHENTICATED` | Local escape hatch — never set in production |

## Deploy (Google Cloud Run)

One service (`forge-web`); Cloud Scheduler drives the tick.

```bash
gcloud builds submit --tag gcr.io/$PROJECT/forge-web --file apps/web/Dockerfile .

gcloud run deploy forge-web \
  --image gcr.io/$PROJECT/forge-web \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars DATABASE_URL=...,BETTER_AUTH_SECRET=...,TICK_EXPECTED_AUDIENCE=https://forge-web-xxxx.a.run.app,TICK_EXPECTED_ISSUER_EMAIL=scheduler@$PROJECT.iam.gserviceaccount.com

gcloud scheduler jobs create http forge-tick \
  --schedule="* * * * *" \
  --uri="https://forge-web-xxxx.a.run.app/api/tick" \
  --http-method=POST \
  --oidc-service-account-email=scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience="https://forge-web-xxxx.a.run.app"
```

Secrets belong in Secret Manager, mounted with `--set-secrets` — see [`docs/forge-prd.md`](docs/forge-prd.md) §15. The tick route is fail-closed: without both OIDC variables set it refuses every request rather than accepting unverified ones.

## What it costs

Real, tier-priced numbers from Forge's own repository: a bug fix runs 39–73 tool calls over roughly 15 minutes for **$1–4**; a six-task planned feature came to about **$16**. Cost is dominated by context carriage, not generation — one run generated 42k tokens while carrying 11.7M, most of them cheap cache reads. Budgets are enforced per Mission and per Task, and Forge prices usage by tier rather than summing tokens at face value (which overstates real cost by roughly 10×).

## Scripts

| Command | Effect |
| --- | --- |
| `pnpm dev` | Run `forge-web` on :3100, tick engine included |
| `pnpm build` | Build every workspace package |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm lint` | Lint every package |
| `pnpm test` | Run all Vitest suites (1,250+) |
| `pnpm format` | Prettier over the repo |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Issues labelled `good first issue` are a reasonable place to start — and if you have Forge running, you can dispatch one to an agent and review what it writes.

## License

[MIT](LICENSE).
