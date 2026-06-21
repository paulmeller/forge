# Forge

**Open-source Missions for Claude Managed Agents. Swap in your own gateway when you need to.**

Forge is an orchestration layer that turns Anthropic's Managed Agents into a fleet of autonomous coding agents. Describe work as a **Mission** ("bump fast-glob across 140 repos", "add OTel spans to every HTTP handler", "triage every P3 bug"); Forge plans it into parallel Tasks, dispatches each to an agent session, opens PRs, gates on CI and review, and merges what's green. Every action lands in an auditable Ledger, gated by per-Mission budgets.

Managed Agents is the primary execution backend. **AgentStep Gateway is a drop-in replacement** via a single env flag — for teams that need self-hosting (compliance) or cheaper sandboxes (cost).

Full product spec: [`docs/forge-prd.md`](docs/forge-prd.md).

---

## Status

**Early, but working end to end.** Missions, parallel dispatch, CI gating, budget caps, and the audit ledger all function — this is young software, so expect rough edges and review what agents ship before merging it.

## Architecture in one paragraph

Two Cloud Run services share one libSQL/Turso database. **`forge-web`** (Next.js) hosts the Console, the public API, and the HMAC-verified webhook receiver. **`forge-tick`** (Fastify) runs a single `POST /tick` endpoint invoked by Cloud Scheduler every 60 seconds; one tick claims queued Tasks, runs the Gate (open PRs, poll CI, retry/merge), and checks Mission budgets. Nothing is vendor-exclusive — the same containers run anywhere that can host a Node process.

## Repo layout

```
forge/
├── apps/
│   ├── web/          # Next.js — Console + API + webhook receiver
│   └── tick/         # Fastify — the tick loop
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
cp apps/tick/.env.example apps/tick/.env.local

# Generate and apply the initial migration
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate

# Run both services with live reload
pnpm dev
```

`forge-web` is at [http://localhost:3100](http://localhost:3100). `forge-tick` listens on [http://localhost:8080](http://localhost:8080); trigger a tick manually with:

```bash
curl -X POST http://localhost:8080/tick
```

(OIDC verification is bypassed locally via `TICK_ALLOW_UNAUTHENTICATED=true`.)

## Deploy (Google Cloud Run)

Both services deploy as Cloud Run containers in the same GCP project and region.

```bash
# Build and push images (substitute your project + region)
gcloud builds submit --tag gcr.io/$PROJECT/forge-web --file apps/web/Dockerfile .
gcloud builds submit --tag gcr.io/$PROJECT/forge-tick --file apps/tick/Dockerfile .

# Deploy web (public)
gcloud run deploy forge-web \
  --image gcr.io/$PROJECT/forge-web \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars DATABASE_URL=...,BETTER_AUTH_SECRET=...

# Deploy tick (private — only Cloud Scheduler can invoke)
gcloud run deploy forge-tick \
  --image gcr.io/$PROJECT/forge-tick \
  --region $REGION \
  --no-allow-unauthenticated \
  --set-env-vars DATABASE_URL=...,TICK_EXPECTED_AUDIENCE=https://forge-tick-xxxx.a.run.app,TICK_EXPECTED_ISSUER_EMAIL=scheduler@$PROJECT.iam.gserviceaccount.com

# Wire Cloud Scheduler to invoke the tick every 60s with OIDC
gcloud scheduler jobs create http forge-tick-60s \
  --schedule="* * * * *" \
  --uri="https://forge-tick-xxxx.a.run.app/tick" \
  --http-method=POST \
  --oidc-service-account-email=scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience="https://forge-tick-xxxx.a.run.app"
```

Secrets belong in Google Secret Manager, mounted via `--set-secrets` — see [`docs/forge-prd.md`](docs/forge-prd.md) §15.

## Scripts

From the repo root:

| Command            | Effect                                     |
| ------------------ | ------------------------------------------ |
| `pnpm dev`         | Run `forge-web` (:3100) and `forge-tick` (:8080) in parallel |
| `pnpm build`       | Build every workspace package              |
| `pnpm typecheck`   | Run `tsc --noEmit` across all packages     |
| `pnpm lint`        | Lint every package                         |
| `pnpm test`        | Run all Vitest suites                      |
| `pnpm format`      | Prettier over the repo                     |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE).
