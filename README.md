# Forge

**Open-source Missions for Claude Managed Agents. Swap in your own gateway when you need to.**

Forge is an orchestration layer that turns Anthropic's Managed Agents into a fleet of autonomous coding agents. Describe work as a **Mission** ("bump fast-glob across 140 repos", "add OTel spans to every HTTP handler", "triage every P3 bug"); Forge plans it into parallel Tasks, dispatches each to an agent session, opens PRs, gates on CI and review, and merges what's green. Every action lands in an auditable Ledger, gated by per-Mission budgets.

Managed Agents is the primary execution backend. **AgentStep Gateway is a drop-in replacement** via a single env flag — for teams that need self-hosting (compliance) or cheaper sandboxes (cost).

Full product spec: [`docs/forge-prd.md`](docs/forge-prd.md).

---

## Status

**Early, but working end to end.** Missions, parallel dispatch, CI gating, budget caps, and the audit ledger all function — this is young software, so expect rough edges and review what agents ship before merging it.

## Architecture in one paragraph

A single self-hosted Next.js app, **`forge-web`**, backed by one libSQL/Turso database. It hosts the Console, the public API, the HMAC-verified webhook receiver, and the tick engine itself — the engine lives at `apps/web/src/server/tick/` and runs a full pass whenever Cloud Scheduler POSTs to `POST /api/tick` (OIDC-verified) every 60 seconds; one tick claims queued Tasks, runs the Gate (open PRs, poll CI, retry/merge), and checks Mission budgets. Nothing is vendor-exclusive — the same container runs anywhere that can host a Node process.

## Repo layout

```
forge/
├── apps/
│   └── web/          # Next.js — Console + API + webhook receiver + tick engine (src/server/tick/)
├── packages/
│   └── db/           # Drizzle schema + libSQL client factory
├── docs/
│   └── forge-prd.md  # Product spec
└── .github/workflows/
    └── ci.yml        # Lint, typecheck, test, container build
```

## Requirements

- Node 22 (`.nvmrc` pins it).
- pnpm 10.
- Docker (for building containers locally; not required for `pnpm dev`).

## Local dev

```bash
# First time
pnpm install
cp apps/web/.env.example apps/web/.env.local

# Generate and apply the initial migration
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate

# Run the app with live reload
pnpm dev
```

`forge-web` is at [http://localhost:3100](http://localhost:3100). There's no scheduled tick locally — trigger one via the Console's manual "Run tick now" button, or curl the route directly (requires `TICK_ALLOW_UNAUTHENTICATED=true` in `apps/web/.env.local`):

```bash
curl -X POST http://localhost:3100/api/tick
```

## Deploy (Google Cloud Run)

Forge deploys as a single Cloud Run service (`forge-web`); Cloud Scheduler drives the tick by POSTing to that service's `/api/tick` route.

```bash
# Build and push the image (substitute your project + region)
gcloud builds submit --tag gcr.io/$PROJECT/forge-web --file apps/web/Dockerfile .

# Deploy web (public)
gcloud run deploy forge-web \
  --image gcr.io/$PROJECT/forge-web \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars DATABASE_URL=...,BETTER_AUTH_SECRET=...,TICK_EXPECTED_AUDIENCE=https://forge-web-xxxx.a.run.app,TICK_EXPECTED_ISSUER_EMAIL=scheduler@$PROJECT.iam.gserviceaccount.com

# Wire Cloud Scheduler to invoke /api/tick every 60s with OIDC
gcloud scheduler jobs create http forge-tick \
  --schedule="* * * * *" \
  --uri="https://forge-web-xxxx.a.run.app/api/tick" \
  --http-method=POST \
  --oidc-service-account-email=scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience="https://forge-web-xxxx.a.run.app"
```

Secrets belong in Google Secret Manager, mounted via `--set-secrets` — see [`docs/forge-prd.md`](docs/forge-prd.md) §15.

## Scripts

From the repo root:

| Command            | Effect                                     |
| ------------------ | ------------------------------------------ |
| `pnpm dev`         | Run `forge-web` (:3100), including the in-process tick engine |
| `pnpm build`       | Build every workspace package              |
| `pnpm typecheck`   | Run `tsc --noEmit` across all packages     |
| `pnpm lint`        | Lint every package                         |
| `pnpm test`        | Run all Vitest suites                      |
| `pnpm format`      | Prettier over the repo                     |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE).
