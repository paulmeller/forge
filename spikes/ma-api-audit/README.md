# MA API audit probe

A live, runnable probe against Anthropic's Managed Agents API that validates every primitive Forge's adapter depends on. Companion to [`docs/ma-api-audit.md`](../../docs/ma-api-audit.md).

## What it does

1. Creates an environment (`cloud`, unrestricted networking).
2. Creates an agent with the prebuilt agent toolset enabled.
3. Creates a session referencing both.
4. Sends a trivial `user.message` asking the agent to reply with `pong`.
5. **Polls `sessions.events.list` every 2s** — the same path Forge's tick uses — until the session goes idle with a terminal `stop_reason` or terminates.
6. Prints a summary: session ID, event count by type, token usage, captured agent text, wall time.
7. Archives the session + agent and deletes the environment for cleanup.

If it runs to completion, every §12 primitive is verified against the live API.

## Run it

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @forge/spike-ma-api-audit install
pnpm --filter @forge/spike-ma-api-audit start
```

Total cost: a few hundred tokens on `claude-opus-4-7` (one short turn).

## Expected output

```
[+0.0s] creating environment { name: 'forge-spike-env-...' }
[+1.4s] environment created { id: 'env_...' }
[+1.4s] creating agent { name: 'forge-spike-agent-...' }
[+2.1s] agent created { id: 'agent_...', version: ... }
[+2.1s] creating session
[+4.8s] session created { id: 'sesn_...', status: 'running' }
[+4.8s] sending user message
[+4.9s] polling events (this is the path the Forge tick will use)

===== probe summary =====
session:           sesn_...
events seen:       N
event type counts:
  agent.message                            1
  session.status_idle                      1
  session.status_running                   1
  span.model_request_end                   1
  span.model_request_start                 1
  user.message                             1
usage (tokens):
  input               ...
  output              ...
  cache_creation      0
  cache_read          0
agent response:    "pong"
wall time:         ~10s
```

## Why this artifact exists

Before committing 10 weeks of Phase 1 work against an unverified substrate, we wanted a yes/no answer on: do the primitives the PRD §12 gating risk enumerated actually exist in the shape we assumed? This script is that answer, verifiable on any machine with an API key.

It is also the first real code that will inform the `managed-agents` adapter in `apps/tick` — the SDK method names, event shapes, and pagination semantics it uses are exactly what the adapter will use.

## Cleanup notes

The probe archives the session and agent it creates. **Agent archive is permanent on Anthropic's side** — there is no unarchive. Running the probe repeatedly accumulates archived agents in the Anthropic workspace. That's fine for a dev account; don't run this against a production organization.
