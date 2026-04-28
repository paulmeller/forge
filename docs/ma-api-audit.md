# Managed Agents API Audit

**Status:** Complete (docs-level — probe script is `spikes/ma-api-audit/`)
**Date:** 2026-04-25
**Purpose:** Resolve the Phase 1 gating risk in PRD §12 — does the Anthropic Managed Agents API expose the primitives Forge needs?

---

## TL;DR

**Yes, Phase 1 is unblocked — with one PRD amendment.**

Every primitive Forge needs exists today in the Managed Agents beta (`managed-agents-2026-04-01`). The one mismatch: Forge's PRD §7.8 assumed HMAC-verified webhooks pushed *from* Anthropic to our server. The MA API does not do that. Instead, we pull events — either by holding an SSE stream open per active session, or by paginated polling of `GET /v1/sessions/{id}/events`.

This is not a blocker. It simplifies the architecture: the tick already runs every 60s; it can poll events for each running session as part of the same pass. The webhook receiver we scaffolded at `apps/web/src/app/api/forge/webhook/[missionId]` now serves only the gateway path (where we control the contract), not the MA path.

---

## Primitive-by-primitive verdict

| PRD §12 primitive | MA endpoint / mechanism | Notes |
|---|---|---|
| Session create | `POST /v1/sessions` | Session references a pre-created agent by ID + an environment. `model`/`system`/`tools` live on the agent, not the session. |
| Turn append | `POST /v1/sessions/{id}/events` with `user.message` | Messages queue; session processes in order without waiting. |
| Event stream | `GET /v1/sessions/{id}/events/stream` (SSE) or `GET /v1/sessions/{id}/events` (paginated) | Polling returns immediately — **not** a long-poll. |
| Usage accounting | `span.model_request_end` events | Carry `model_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. |
| Cancel | `user.interrupt` event, then `sessions.archive` or `sessions.delete` | Interrupt jumps the queue; session goes idle at the next safe boundary. |
| HMAC-verified webhooks delivered to Forge | **Does not exist** | Forge is the puller, not the push target. |

---

## Architecture implications

### The webhook → poll pivot

**What PRD §7.8 described:**
```
MA session event → POST /api/forge/webhook/:missionId (HMAC-verified)
                 → verify, append Ledger, return 200 fast
                 → tick reconciles state
```

**What actually works on MA:**
```
tick runs every 60s
  for each running Task:
    events.list(session_id, since=last_seen_event_id)
    append new events to Ledger
    advance Task state (turn_ended, awaiting_ci, etc.)
    if session terminated: reconcile, close Task
```

The gateway adapter can still push webhooks if we design it that way — we control that contract. The webhook endpoint in `apps/web` stays, but it's a gateway-only surface now.

### Agent lifecycle: setup, not runtime

Agents are persistent, versioned config objects. The correct pattern is:

- **Once per Mission config (or per Forge deployment):** `client.beta.agents.create({name, model, system, tools, mcp_servers, skills})` → store `agent_id` + `version`.
- **Every Task dispatch:** `client.beta.sessions.create({agent: agent_id, environment_id, resources, vault_ids})` → store `session_id` on the Task row.

This lines up with PRD §7.1's `agent_id` field on the Mission row. What we haven't specced: *when* and *how* Forge calls `agents.create`. Options:

1. **Mission-scoped agent** — when a Mission is created with a new agent config, Forge calls `agents.create` once and stores the ID. Clean and versioned.
2. **Operator-managed** — operator creates agents out-of-band (Anthropic CLI, their own dashboard) and supplies the ID. Zero Forge-side lifecycle.
3. **Hybrid** — operator can paste an existing ID, or let Forge create one from a template.

v1 leaning: **(2)**, with (1) as a fast-follow. Operator-managed is the minimum-viable path — no agent creation UI, no versioning UI, no archive UI (which is permanent and scary). Forge just accepts an ID.

### GitHub PR creation is a two-step wire-up

The PRD glosses over this. To open a PR on an attached repo, the agent needs:

1. **`github_repository` resource** on the session — for clone, branch, and push (auth via an Anthropic-side git proxy; the token never enters the container).
2. **GitHub MCP server** declared on the agent, plus a vault credential attached to the session — for the `create_pull_request` tool call.

If we only attach the repo resource, the agent can commit and push a branch but cannot open the PR. This doesn't change Phase 1 scope dramatically but it does mean:

- The `Mission` config needs a GitHub vault ID (for MCP auth), not just an installation ID (for repo clone).
- The dispatcher needs to pass both on `sessions.create`.

### Streaming vs polling

We have three options for consuming events. Recommendation: **paginated polling** for v1.

| Approach | Pros | Cons |
|---|---|---|
| **Paginated polling** (recommended v1) | Stateless. Fits Cloud Run scale-to-zero. No reconnection logic. Fits tick cadence naturally. | 60s max latency on state transitions. Extra request volume (one per running Task per tick). |
| **SSE streaming** | Lower latency on events. | Requires persistent connections → can't scale to zero. Needs reconnect-with-consolidation on drops. Implies a new always-on service. |
| **Hybrid** | Stream active sessions, poll as backstop. | Most complex. Two failure modes to debug. |

Polling it is. The cost is ~1 extra `GET /events` call per active Task per minute — well under MA's 600 RPM "other operations" limit for organizations.

---

## What changes in the PRD

| § | Current | Should become |
|---|---|---|
| §7.8 Webhooks | "Forge exposes POST /api/forge/webhook/:missionId for backend events…" | "MA path: Forge polls `sessions.events.list` each tick per running Task and appends to the Ledger. Gateway path: gateway posts to `POST /api/forge/webhook/:missionId` (HMAC-verified)." |
| §7.9 Engine adapters | Interface: `createSession`, `sendTurn`, `cancelSession`. | Add: `listEvents(sessionId, sinceEventId?)` and `getSession(sessionId)`. Both adapters must implement; the tick calls `listEvents` to drive Task state. |
| §7.1 Missions | Has `agent_id`. | Clarify: agent ID is operator-supplied in v1. Also add `github_vault_id` (for GitHub MCP auth), distinct from `github_installation_id`. |
| §7.11 Non-functional | Tick cadence = 60s, tick duration < 2s at 500 Tasks. | Still correct, but note that tick duration now includes one `events.list` per running Task. Budget that. |
| §12 Risks | "MA API surface is unknown/unverified (gating)." | Resolved. Replace with: "MA API rate limits (600 RPM for list operations, 60 RPM for creates). At 500 concurrent Tasks polling per tick, we're well inside. At >2k, we need batch-aware polling or shift to streaming." |

---

## Rate limit math

MA limits (per organization, per the API reference):

| Operation class | Rate limit |
|---|---|
| Creates (agents, sessions, vaults) | 60 RPM |
| All other operations (list, get, events) | 600 RPM |
| Environments (all ops) | 60 RPM, max 5 concurrent |

Forge's steady-state load per tick (60s cadence):

| Call | Count |
|---|---|
| `sessions.events.list` — one per running Task | N |
| `sessions.retrieve` — occasional status check | ≤ N / 10 |
| Create calls (new dispatches) | bounded by `concurrency_cap` |

At 500 running Tasks (our stated scale target), we issue ~500 list calls per minute — well under the 600 RPM cap, with headroom for retries and status checks. At 2000+ Tasks we'd need to either batch (not supported on MA) or move to streaming. That's a scale problem, not a Phase 1 problem.

---

## What's in the probe script

`spikes/ma-api-audit/index.ts` is a runnable TypeScript probe. Given `ANTHROPIC_API_KEY`, it:

1. Creates an environment (`cloud` + unrestricted networking).
2. Creates an agent (`agent_toolset_20260401` enabled, no MCP, no system prompt).
3. Creates a session referencing both.
4. Sends a trivial `user.message` ("Reply with the single word 'pong'.").
5. Polls `events.list` every 2s until the session goes idle with a terminal stop reason.
6. Prints: session ID, event count, elapsed time, usage totals.
7. Archives the session and the agent for cleanup.

Running this end-to-end is how we verify the bindings on our machine, the exact SDK method names and shapes, and the wire format for events. It's the first real code that will inform the `managed-agents` adapter implementation.

**To run:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @forge/spike-ma-api-audit start
```

---

## Open questions this audit does not resolve

- **Pricing predictability.** We have per-token input/output pricing via `model_usage`, but the cost of the container runtime itself (CPU-minutes, egress) is not line-item-visible in events. Worth confirming with Anthropic whether "cost" in the ledger is model tokens only, or model + infra, or if infra is flat-rate included.
- **Rate limit observability.** MA returns `retry-after` on 429, but there's no `x-ratelimit-remaining` header documented. If we want to surface "burn rate" in the Console, we may need to track it ourselves.
- **Session idle post-write race.** The SSE stream emits `session.status_idle` slightly before the session's queryable status reflects it. Doesn't affect polling, but worth testing — if we see the same race in `events.list` results, the tick needs to be idempotent across ticks (which it already is by design).

None of these are Phase 1 blockers.
