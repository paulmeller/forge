# Operator Setup Guide

This guide gets a new operator from a fresh clone to the first local Mission. For product context, read the [README](../README.md) and [Forge PRD](./forge-prd.md) instead of duplicating them here.

## 1. Prerequisites

- Node.js 22; the repo pins the expected version in `.nvmrc`.
- pnpm 10; the root `package.json` declares the exact package manager line.
- Git and a GitHub account with access to the target repositories.
- One execution backend:
  - Anthropic Managed Agents API key, or
  - AgentStep Gateway API key and API URL.

## 2. Clone and Install

```bash
git clone https://github.com/paulmeller/forge.git
cd forge
pnpm install
```

## 3. Create Local Env Files

Copy the checked-in examples, then edit the copies only:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/tick/.env.example apps/tick/.env.local
```

For local web, set `BETTER_AUTH_URL` to the dev port used by `@forge/web`:

```bash
BETTER_AUTH_URL=http://localhost:3100
```

Use one backend path.

### Anthropic Managed Agents

In `apps/web/.env.local`:

```bash
FORGE_BACKEND=managed-agents
ANTHROPIC_API_KEY=sk-ant-...
```

In `apps/tick/.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
FORGE_MA_ENVIRONMENT_ID=env_...
```

Create the Managed Agents agent and environment out of band, then keep the agent ID for the Mission form.

### AgentStep Gateway

In `apps/web/.env.local`:

```bash
FORGE_BACKEND=gateway
GATEWAY_URL=https://www.agentstep.com
```

In `apps/tick/.env.local`:

```bash
GATEWAY_URL=https://www.agentstep.com
GATEWAY_API_KEY=agst_...
```

Create the AgentStep environment, agent, and vault with the API. Use the canonical `www.agentstep.com` host so POST bodies are not lost to redirects.

```bash
export GATEWAY_URL=https://www.agentstep.com
export GATEWAY_API_KEY=agst_...

curl -sS -X POST "$GATEWAY_URL/v1/environments" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-local",
    "config": {
      "type": "cloud",
      "provider": "sprites",
      "networking": { "type": "unrestricted" }
    }
  }'

curl -sS -X POST "$GATEWAY_URL/v1/agents" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-codex",
    "engine": "codex",
    "model": "gpt-5.4"
  }'

curl -sS -X POST "$GATEWAY_URL/v1/vaults" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-github",
    "agent_id": "agent_..."
  }'
```

Save the returned `agent_...`, environment ID, and `vault_...`. Paste the agent ID and vault ID into the Mission form when requested.

## 4. Run Migrations

Generate and apply the local database migration:

```bash
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate
```

## 5. Start Forge

Run both services from the repo root:

```bash
pnpm dev
```

- Console: `http://localhost:3100`
- Tick service: `http://localhost:8080`

## 6. Sign Up

Open `http://localhost:3100/signup` and create the first local operator account.

## 7. Create the First Mission

In the Console, go to `http://localhost:3100/missions/new` and fill in:

- Name and goal prompt.
- Backend: Anthropic Managed Agents or AgentStep Gateway.
- Agent ID from the backend setup.
- Target repositories as `owner/repo`, one per line.
- Optional GitHub installation ID and GitHub MCP vault ID before dispatching real Tasks.

Submit the form. The Mission starts as `draft`; use the Mission page to plan and start it.

## 8. Trigger a Tick

With `pnpm dev` still running, invoke the local tick loop:

```bash
curl -X POST http://localhost:8080/tick
```

Local unauthenticated ticks are allowed by `TICK_ALLOW_UNAUTHENTICATED=true` in `apps/tick/.env.example`.

## 9. Watch Mission Control

Open the Mission from `http://localhost:3100/missions`. Mission Control shows task status, ledger activity, budget state, and links to deeper task or ledger views. Keep the tick service running or invoke `/tick` again to advance queued work.
