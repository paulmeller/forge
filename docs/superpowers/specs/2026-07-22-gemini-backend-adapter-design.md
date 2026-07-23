# Gemini Backend Adapter — Design

## Motivation

`BackendAdapter` (`apps/web/src/server/tick/adapters/types.ts`) is deliberately backend-agnostic — its own comment states "callers (dispatcher, poller, Gate) don't know which adapter is underneath." Two adapters exist today: `ManagedAgentsAdapter` (Anthropic's Managed Agents Beta) and `GatewayAdapter` (AgentStep's open-source drop-in clone of the same `/v1/sessions/*` protocol). Google's Gemini API shipped its own hosted-agent equivalent — the Interactions API (GA June 2026) plus a Managed Agents preview with a hosted sandbox — making a third adapter a real, scoped, buildable feature: implement the same six methods against Gemini's REST surface, without touching the dispatcher, poller, or Gate.

This spec adds `GeminiManagedAgentsAdapter`, a new `BackendKind`, and the event-translation layer needed to bridge Gemini's fundamentally different protocol shape (one polled interaction object with a `steps` array) into Forge's discrete `BackendEvent` stream.

## Research Findings (verified live, not assumed)

Two things about Gemini's actual API surface were verified empirically before this design was written, not taken on faith from documentation:

1. **No tool-approval gate exists for the agent's own sandbox tool calls.** Four independent official Google doc sources (`ai.google.dev` and `docs.cloud.google.com`) consistently describe a "configure access upfront, then the agent executes autonomously" model, with no runtime pause-for-approval mechanism for tools the agent's own hosted sandbox executes (distinct from *caller-defined custom functions*, which do pause at `requires_action` for the caller to execute and report back — a different, caller-driven mechanism not used by this design). This was confirmed live: a `POST /v1beta/interactions` request with `tools: [{"type": "code_execution"}]` returned `"status": "completed"` on the first response, with the `code_execution_call` and its `code_execution_result` already both present — no intermediate approval round-trip.
2. **A Vault-equivalent credential mechanism exists.** `environment.network.allowlist` entries (domain + header `transform`) let credentials be injected into outbound requests by an egress proxy, never exposed inside the sandbox as an env var, file, or visible token — directly analogous to Anthropic Managed Agents' Vault mechanism.

These findings directly shape the scope decisions below.

## Scope

- A new adapter, `GeminiManagedAgentsAdapter`, implementing all six `BackendAdapter` methods against the Gemini Interactions API.
- A new `BackendKind`/`Backend` value: `'gemini-managed-agents'`.
- **No GitHub MCP server is attached to Gemini sessions in v1.** This is the one deliberate scope boundary: Anthropic's `confirmToolUse` has no Gemini equivalent (finding #1 above), so rather than accept a real feature-parity gap (running an unconfirmed GitHub-write-capable tool), this design avoids the situation entirely — the Gemini agent never has a tool that would need approval-gating. It still has `code_execution` (Gemini's own hosted sandbox tool — the equivalent of "the sandbox has bash," needed for the agent to do any real work at all), which the same live check confirmed runs autonomously with no gate, same risk profile as Anthropic's own bash tool.
- PR creation for Gemini-backed tasks relies entirely on the existing, already-backend-agnostic `reconciler.tryOpenPr()` fallback (built for Codex/OpenCode, which also lack MCP tools) — no changes needed there.
- No changes to `dispatcher.ts`, `poller.ts`, `state.ts`'s existing transition logic, `reconciler.ts`, or any gate (`ci.ts`/`verify.ts`/`ai-review.ts`/`auto-merge.ts`/`budgets.ts`).

## Backend Registration

- `packages/db/src/schema.ts:14` — extend `export const backend = ['managed-agents', 'gateway'] as const;` to include `'gemini-managed-agents'`. `backend` is a plain `text()` column (`schema.ts:90`) with only a TypeScript-level enum annotation — no DB migration required.
- `apps/web/src/server/tick/adapters/types.ts` — extend `BackendKind` the same way.
- `apps/web/src/server/tick/adapters/index.ts` — add a third `case 'gemini-managed-agents'` in `getAdapter()`'s switch, following the existing pattern (env var presence checks, then construct and cache the adapter singleton).
- New env var: `GEMINI_API_KEY` (required for this backend), following the existing `optional()`/`required()` pattern in `apps/web/src/lib/env.ts`. Documented in `apps/web/.env.example` alongside the other backend-specific vars.

## Session Creation & Credentials

`createSession(input: CreateSessionInput)` maps to:

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
{
  "model": env.FORGE_GEMINI_MODEL,   // new env var, e.g. "gemini-pro-latest"
  "background": true,
  "tools": [{ "type": "code_execution" }],
  "environment": {
    "type": "remote",
    "network": {
      "allowlist": [
        { "domain": "github.com", "transform": { "Authorization": `Bearer ${input.repoCloneToken}` } },
        { "domain": "api.github.com", "transform": { "Authorization": `Bearer ${input.repoCloneToken}` } },
        { "domain": "*" }
      ]
    }
  },
  "input": assembledPrompt
}
```

`repoCloneToken` is never embedded in `assembledPrompt` — it only appears in the `environment.network.allowlist` transform, which Gemini's egress proxy applies to matching outbound requests without exposing it inside the sandbox (verified finding #2). `assembledPrompt` prepends a short setup instruction (mirroring `dispatcher.ts`'s existing `gitIdentitySetup()` pattern) telling the agent to configure git for header-based HTTPS auth (`git config --global http.https://github.com/.extraHeader "Authorization: Bearer placeholder"`) rather than a token-in-URL clone scheme, then clone `input.repoUrl` at `input.baseBranch`.

**Flagged, not assumed:** the exact interaction between git's own `http.extraHeader` request and the egress proxy's header injection/override needs one empirical validation at implementation time (does the proxy replace whatever value git sends, or does git need to send no header at all for the proxy to add one?) — this is implementation Task 1, not a design assumption, following the same "verify live, don't guess" approach used for the two research findings above.

The returned `id` (Gemini's interaction ID) becomes this adapter's `sessionId`.

`input.agentId` and `input.githubMcpVaultId` are accepted per the `CreateSessionInput` contract (`dispatcher.ts` passes them uniformly to every adapter) but are unused by this adapter: v1 has no persisted Gemini agent-config resource (the model comes from `env.FORGE_GEMINI_MODEL`, not a per-mission agent ID) and no MCP vault (no MCP tools attached, so there is no vault to select).

## Event Translation

Gemini's protocol returns one polled interaction object with a `status` and a `steps` array — nothing like Anthropic's discrete event stream. `listEvents(input: ListEventsInput)` calls `GET /v1beta/interactions/{sessionId}?last_event_id=...` and translates the result into two layers of synthetic `BackendEvent`s:

**State-driving events** (what `state.ts`'s `transition()` actually consumes). Gemini's `status` field has no literal "running" value, so the adapter maps its enum explicitly rather than passing it through:

| Gemini `status` | Synthetic `BackendEvent` | Synthetic ID |
|---|---|---|
| `queued` / `in_progress` (first poll seen for this session) | `session.status_running` | `${interactionId}:status:running` |
| `completed` | `session.status_idle`, `raw.stop_reason = { type: 'end_turn' }` | `${interactionId}:status:completed` |
| `failed` / `incomplete` / `budget_exceeded` | `session.error`, message from the interaction's error field (or the status itself, e.g. `'gemini interaction incomplete'`, when no explicit error message is present) | `${interactionId}:status:${status}` |
| `cancelled` | `session.status_terminated` | `${interactionId}:status:cancelled` |
| `requires_action` | treated the same as `failed` — a `session.error` ("unexpected requires_action: v1 attaches no tool that should produce this state") | `${interactionId}:status:requires_action` |

No `agent.mcp_tool_result` translation is ever needed or produced — v1 has no MCP tools, so the task rides `turn_ended` (via the `completed` → `session.status_idle` mapping above) straight into the existing `tryOpenPr()` fallback, identical to the Codex/OpenCode path already in production.

Each synthetic ID is deterministic and emitted at most once per session, so re-polling an already-settled interaction (e.g. still `completed` on a later tick) does not re-emit the same transition and re-trigger `state.ts` logic twice.

**Observability events** (additive, not required for the state machine, matching the ledger richness Anthropic's adapter already provides for the mission timeline UI):
- `thought` steps → `agent.thinking`
- `model_output` steps → `agent.message`
- `code_execution_call` steps → `agent.tool_use`
- `code_execution_result` steps → `agent.tool_result`

Each step is translated once — the adapter tracks which step IDs (from Gemini's `steps[].id`/`call_id`) it has already emitted as events for a given session, so re-polling a still-`in_progress` interaction only emits events for steps new since the last poll.

## Cost Tracking

Gemini's `usage` field is cumulative per interaction (`total_input_tokens`, `total_output_tokens`), not incremental. The adapter keeps an in-memory `Map<sessionId, number>` of last-seen cumulative total and emits one `span.model_request_end` event per poll carrying `costTokensDelta = currentTotal - lastSeenTotal` (only when positive). A process restart resets this map to zero, causing at most one poll's worth of one-time over-counting after a restart — accepted as a minor, bounded imprecision, the same category of trade-off any at-least-once event system already has.

## `confirmToolUse`

```ts
async confirmToolUse(): Promise<void> {
  throw new Error('GeminiManagedAgentsAdapter: confirmToolUse should be unreachable — v1 never attaches a tool requiring confirmation');
}
```

v1 never offers a tool that produces a confirmation-required state, so this method should never be called by the poller. Throwing (rather than silently no-op'ing) surfaces loudly if that invariant is ever violated — e.g. by a future change that attaches a tool needing approval without updating this adapter.

## Testing

Follows `apps/web/src/server/tick/adapters/managed-agents.test.ts`'s existing convention: mock the HTTP layer entirely (no live Gemini API calls in the suite, consistent with every other test in this repo). Coverage:

- `createSession` request shape: asserts the `environment.network.allowlist` transform carries the clone token (not embedded in `input`), `tools` contains only `code_execution` (never an MCP server), `background: true` is set.
- `listEvents` status→event translation: every status in the mapping table (`queued`/`in_progress` → running, `completed` → idle/`end_turn`, `failed`/`incomplete`/`budget_exceeded` → error, `cancelled` → terminated, `requires_action` → error), and that re-polling a settled interaction does not re-emit a duplicate transition (stable synthetic IDs).
- `listEvents` observability translation: `thought`/`model_output`/`code_execution_call`/`code_execution_result` steps map to the expected `BackendEventKind`s, and repeated polls of a still-`in_progress` interaction only emit events for new steps.
- Cost tracking: cumulative usage correctly converts to a per-poll delta across multiple polls.
- `confirmToolUse` throws.
- `adapter-contract.test.ts` (existing, shared across adapters) — `GeminiManagedAgentsAdapter` must satisfy the same `BackendAdapter` interface checks `ManagedAgentsAdapter`/`GatewayAdapter` already do.

## Explicitly Out of Scope

- GitHub MCP tool support for Gemini missions — deferred until Gemini ships (or is confirmed to have) an equivalent to Anthropic's `confirmToolUse` approval gate. Revisit this spec's scope decision if that changes.
- Gemini's `stream: true` SSE mode — rejected (Approach B during design) because it requires holding an open HTTP connection for the whole turn, fighting Forge's poller-based architecture and its Cloud Run scale-to-zero economics.
- Any change to `dispatcher.ts`, `poller.ts`, `state.ts`, `reconciler.ts`, or any gate module — this feature is additive at the adapter layer only.
- A mission-level UI control for picking which Gemini model to use — v1 reads a single `FORGE_GEMINI_MODEL` env var, matching how `FORGE_CHAT_MODEL` already works for the chat route. Per-mission model selection is a future enhancement if needed.
