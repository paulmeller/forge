# Forge — Product Requirements Document

**Status:** Draft
**Owner:** (tbd)
**Last updated:** 2026-04-24
**Target branch:** `claude/forge-orchestration-layer-syO96`

---

## 1. Summary

Forge is an open-source orchestration layer that turns Anthropic's Managed Agents into a fleet of autonomous coding agents. Operators describe work as a **Mission** ("bump fast-glob across 140 repos", "add OTel spans to every HTTP handler", "triage and fix all P3 bugs"). Forge plans the Mission into parallel Tasks, dispatches each to a Managed Agents session, opens PRs, gates on CI and review, and merges what's green. Every action is tracked in an auditable Ledger with per-Mission budgets.

Managed Agents is the primary execution backend. **AgentStep Gateway is a drop-in replacement** via a single config flag for teams that need self-hosting (compliance) or cheaper sandboxes (cost).

---

## 2. Problem

Engineering orgs increasingly want to run large, parallel, autonomous changes across their codebase — dependency bumps, codemods, observability rollouts, backlog triage. Today that work sits in an ugly middle: too broad to supervise turn-by-turn in a chat UI, too specific for a one-size-fits-all bot like Dependabot, and too sensitive for closed black-box products like Devin.

What's missing is an **open, auditable orchestration layer** that sits above the execution plane — one that enforces budget, opens gated PRs, and leaves a ledger an operator can trust. Anthropic's Managed Agents solves the execution side. Forge solves the orchestration side.

---

## 3. Positioning

> **Open-source Missions for Claude Managed Agents. Swap in your own gateway when you need to.**

Against **Devin / Factory / Copilot coding agent:** open, inspectable, portable; you own the ledger and the policies.
Against **OpenHands / SWE-agent:** fleet-native, not single-task; multi-engine via the gateway adapter.
Against **Anthropic themselves:** Forge runs *on* Managed Agents, not against it. Complement, not competitor.

What Forge is **not:**
- Not a new agent engine.
- Not a sandbox.
- Not a chat UI for single-task work (Anthropic's own UI is better).
- Not an IDE plugin.

---

## 4. Target users

**Primary — Platform / DevEx engineers at mid-to-large orgs.**
Own the "upgrade all services" problem. Already comfortable with CI, GitHub Apps, and budgets-as-policy. Want auditability and cost control, not magic.

**Secondary — Engineering managers / directors.**
Care about Mission progress, cost-per-Mission, and success rate. Live in the Console, not the Task drill-down.

**Tertiary — Open-source maintainers.**
Fleet-fix their own repos (dependency bumps, CI migrations). Sensitive to cost — will prefer the gateway adapter over hosted MA.

**Explicit non-audience:** individual developers doing single-task work. They should use Claude Code, Cursor, or Copilot. Forge's onboarding cost isn't justified below ~10 parallel Tasks.

---

## 5. Goals

- Let an operator go from "I have 50 repos to change" to "50 PRs open, 42 merged, 6 in review, 2 abandoned" without writing orchestration code.
- Keep every run auditable: who ran what, which prompt, which diff, which CI result, what it cost.
- Enforce budget as a first-class primitive — Missions pause automatically at configurable thresholds.
- Make engine choice (Claude vs. Codex vs. Gemini) a Mission-level config, not a code change.
- Preserve the "MA today, gateway tomorrow" swap with a single env var change.
- Ship as open source from day one. Public repo, permissive license, contribution-ready.

### Non-goals (v1)

- Replacing CI, code review tools, or ticket systems — Forge integrates with them.
- Real-time collaboration on a single Task (that's Claude Code's job).
- Multi-tenant SaaS controls (SSO, RBAC, audit exports). Defer until a hosted offering exists.
- Planner DSLs or "no-code" Mission builders. v1 Missions are defined in UI or API, not custom scripts.

---

## 6. Use cases

1. **Dependency bump across a fleet.** "Bump `fast-glob` to ^3.3.2 everywhere it's used." Planner enumerates repos; Tasks run in parallel; auto-merge if diff is small and CI is green.
2. **Codemod rollout.** "Apply this jscodeshift transform to every frontend repo. Revert if tests fail." Retry-with-feedback when tests break; operator sees which repos couldn't be auto-fixed.
3. **Observability backfill.** "Add OTel spans to every HTTP handler in the `payments/*` org." More surgical; likely requires review on every PR.
4. **Backlog triage.** "Take every P3 bug in Linear older than 90 days. Attempt a fix. If the fix is non-trivial, open a draft PR and comment on the ticket."
5. **Security patching.** "For every repo with a CVE alert on `lodash`, bump to the patched version and open a PR." Auto-merge if only `package-lock.json` changes.
6. **Monorepo migration.** "Move services A–G into the monorepo one at a time. Task B cannot start until Task A's PR is merged." Exercises the DAG/dependency feature.

---

## 7. Requirements

### 7.1 Missions

- An operator can create a Mission from the Console or API with: name, goal prompt, Planner strategy, **backend** (`managed-agents` | `gateway`), **agent ID** (interpreted by the chosen backend), concurrency cap, budget (USD and/or tokens), auto-merge policy, and two distinct GitHub credentials: a **repo clone token** (or GitHub App installation) for attaching repos, and a **GitHub MCP vault ID** for the PR-creation tool call. These are separate by design — see [`docs/ma-api-audit.md`](./ma-api-audit.md) for why.
- `backend` and `agent ID` together identify the execution engine. In v1, agents are operator-managed — the operator creates the agent out-of-band (Anthropic CLI, console, or one-off script) and pastes the ID. Forge does not own the agent lifecycle.
- Missions have lifecycle: `draft → planning → running → (paused) → completed | cancelled`.
- Missions can be paused (no new dispatches; in-flight Tasks run to completion) and cancelled (queued Tasks abandoned; in-flight Tasks run to completion).
- Missions auto-pause at a configurable budget threshold (default 80%) and notify the operator.
- Missions surface derived state: task counts by status, total cost, elapsed time, projected completion.

### 7.2 Tasks

- A Task is the atomic unit of work: one repo, one branch, one backend session.
- Task lifecycle: `queued → dispatching → running → turn_ended → opening_pr → awaiting_ci → (awaiting_review) → merging → merged` (terminal) with failure branches `abandoned` and `failed`.
- Tasks carry input (repo, base branch, prompt template variables, optional issue reference) and output (session ID, PR URL, diff stats, CI status, cost).
- Tasks support retry-with-feedback: on CI failure, Forge sends a follow-up turn to the same session with the failing log; up to `retry_count_max` (default 3).
- Tasks support DAG dependencies: a Task can declare `depends_on` another Task; it stays `queued` until the predecessor reaches `merged`.

### 7.3 Planner

- **v1: Rule-based** — operator supplies a repo list (or a GitHub search query); Planner emits one Task per repo. Prompt is a template with `{{repo}}`, `{{base_branch}}`, `{{issue_body}}` variables.
- **v2: LLM-driven** — operator supplies a goal; Planner reads a configured issue tracker and emits Tasks grouping related work.
- **v3: Graph-based** — Planner output can include `depends_on` edges.
- Planner output is inspected and editable before Mission starts — operators can remove, add, or rewrite Tasks.

### 7.4 Dispatcher

- Dispatcher claims `queued` Tasks up to the Mission's `concurrency_cap` on each tick.
- Claim is atomic (optimistic `UPDATE … WHERE status='queued'`) — multiple workers cannot claim the same Task.
- Dispatcher calls the configured backend adapter (`managed-agents` or `gateway`) to create a session with: agent ID, initial user message (rendered template), webhook URL, HMAC secret.
- Dispatcher handles backend errors with exponential backoff and fallback: on 503 or rate-limit, retry; on auth failure or schema error, mark Task `failed` and log.

### 7.5 Gate

- On `session.turn.ended` webhook, Gate runs in the next tick.
- If the agent produced no diff → `abandoned`.
- If diff exists → open PR via GitHub API with standardized title/body, link to the session, set status `awaiting_ci`.
- On CI completion (poll Checks API in v1, webhook in v2):
  - **Success** + auto-merge policy allows → `merging` → `merged`.
  - **Success** + policy requires review → `awaiting_review`.
  - **Failure** + `retry_count < max` → follow-up turn with the CI log, status back to `running`.
  - **Failure** + `retry_count >= max` → `failed` with a review-requested comment.
- Gate decisions are recorded in the Ledger with full reasoning (which policy, which checks, which log excerpt).

### 7.6 Budget

- Per-Mission budget in USD and/or tokens.
- Cost accrues from backend usage events on each webhook.
- Threshold trigger (default 80%) → Mission auto-pauses, Ledger event, operator notification.
- Operator can raise the budget and resume; cannot lower below spent.

### 7.7 Ledger

- Append-only record: Mission and Task events, Planner output, Dispatcher claims, Gate decisions, budget events, webhook payloads.
- Every row has `mission_id`, optional `task_id`, `event_type`, `payload` (json), `created_at`.
- Queryable from the Console by Mission, Task, or event type.
- Exportable as JSON for external audit (v2).

### 7.8 Event ingestion

- **Managed Agents path:** the tick polls `GET /v1/sessions/{id}/events` for each running Task (paginated, with `since_event_id` cursor), appends new events to the Ledger, and advances Task state. Anthropic does not push webhooks — see [`docs/ma-api-audit.md`](./ma-api-audit.md) for the rationale.
- **Gateway path:** the gateway posts to `POST /api/forge/webhook/:missionId`, HMAC-verified with the Mission's secret. Receiver is thin — verify, append Ledger, update Task status, return 200 fast; heavy work deferred to the next tick.
- Both paths land in the same Ledger shape and both feed the same Gate logic downstream.

### 7.9 Engine adapters

- Both adapters implement the same interface: `createSession`, `sendTurn`, `cancelSession`, `listEvents(sessionId, sinceEventId?)`, `getSession(sessionId)`.
- `listEvents` + `getSession` are the tick's primary inputs — the Gate decides Task transitions from the event stream returned by `listEvents` and the lifecycle state returned by `getSession`.
- `managed-agents`: default; talks to Anthropic's hosted API. Uses paginated `events.list` to implement `listEvents`.
- `gateway`: talks to a self-hosted AgentStep Gateway via its `/v1/*` HTTP surface. Gateway may push to the webhook endpoint (§7.8) *and* support `listEvents` polling — the interface is the same either way.
- Adapter choice is per-Mission (`backend` field, see §7.1) and per-deployment (env default).
- **Contract tests** ensure both adapters produce identical Forge-visible behavior. Contract tests live in the gateway repo and run in Forge's CI.

### 7.10 Console

- **Mission list** — table with status, task counts, spend, last event, filters.
- **Mission detail** — header with status/budget/actions, task table with filters, recent Ledger feed.
- **Task detail** — metadata, live session events (SSE from the backend), PR + CI status, Ledger, retry/abandon/force-merge actions.
- **Create Mission form** — name, goal, strategy, backend + agent ID, concurrency, budgets, auto-merge policy, repo source.
- **Planner preview** — after planning, show emitted Tasks with edit/remove before Mission starts.

### 7.11 Non-functional

- **Onboarding:** first Mission running within 10 minutes of install, given an Anthropic API key and a GitHub token.
- **Tick cadence:** the tick runs every 60 seconds (Cloud Scheduler-driven; see §15). A single tick completes in under 2 seconds of wall time at 500 live Tasks. If sub-minute cadence becomes necessary, `forge-tick` flips to `min-instances=1` with an in-process loop — no architectural change.
- **Durability:** no Ledger entry is lost across container restart, rolling deploy, or scheduler failure.
- **Observability:** every external call (backend, GitHub) emits an OTel span; Forge is a single service in the trace.
- **Security:** all mission-scoped secrets encrypted at rest; webhooks HMAC-verified; no secret in logs.

### 7.12 Skills

Skills are the **declarative playbook** a Mission runs under. They answer "how should this kind of Mission be executed" — the protocol, invariants, tool discipline, and templates that keep the agent on the golden path.

- A Mission has an optional `skill_id`. When set, Forge uploads the skill to Managed Agents via the Skills API at Mission start and attaches it to the agent config used for every Task in that Mission.
- **Library + BYO:** Forge ships a `skills/` directory of curated skills for common Mission classes (dependency bump, codemod rollout, OTel backfill, CVE patch). Operators can select from the library or paste their own SKILL.md in the Create Mission form. Library skills are versioned with the repo; BYO skills are stored in the Forge database alongside the Mission.
- **Scope:** skills are per-Mission-class, not per-operator — they encode knowledge that travels across fleets (e.g. "push to `origin`, never to an alternate remote" is true for every MA-backed Mission, not just yours).
- **Authoring:** v1 is manual (operator writes Markdown). The **Retrospective** process (§7.13) produces reviewed diffs against skills — Forge never auto-mutates a skill.
- **Tool discipline:** a skill may declare a minimum toolset. The dispatcher narrows the agent's effective tool list to that minimum when a skill is attached, reducing prompt-cache surface and removing "temptation to wander."

### 7.13 Retrospective

A retrospective is an **operator-initiated, post-Mission analysis phase** that converts the Ledger into proposed improvements. It's how Forge closes the loop between "what happened on real Tasks" and "what our skills and memory should say."

- **Trigger:** operator clicks *Retrospect* on a completed or significantly-failed Mission, or Forge auto-offers one when a Mission's success rate falls below a configurable threshold.
- **Mechanism:** Forge spawns a dedicated read-only agent session — an "analyst" — scoped to the Mission's Ledger, with no tool use except Ledger queries. Its instructions are fixed and live in `prompts/retrospective.md` inside the Forge repo; they cannot be edited per-Mission.
- **Output:** structured proposals in two shapes:
  - **Skill diffs:** markdown patches against the attached skill (or a new skill), each with inline evidence pointers to specific Ledger event IDs that justify the change.
  - **Memory entries:** candidate `(scope, key, value)` records for the fleet memory store (§7.14), each with the same evidence pointers.
- **Review gate:** proposals land in the Console as a review queue. Nothing auto-applies. The operator accepts, edits, or rejects each proposal. Accepted skill diffs become a PR against the skill file; accepted memories persist to the memory store.
- **Audit:** every retrospective run, every proposal, and every reviewer decision lands in the Ledger. The loop from "Ledger evidence → proposal → human decision → applied change" is itself traceable.

### 7.14 Memory

Memory is the **empirical knowledge base** — facts Forge has learned about a specific operator's fleet that are too local to belong in a library skill.

- **Schema:** `(id, scope, scope_key, key, value, confidence, source_mission_id, source_task_id, learned_at, expires_at)`. Scopes are `org | fleet | repo`.
- **Surfacing:** on session create, Forge serves relevant memories (filtered by repo, by backend, by goal keywords) into the agent's prompt via the Managed Agents memory tool's `/memories` directory — the agent reads them when relevant, as with any skill.
- **Confidence:** each memory carries a confidence score updated as more Tasks reference it. Memories seen corroborated across many successful Tasks rise; memories associated with failures decay.
- **Expiry:** every memory has an `expires_at` (default 90 days). After expiry, Forge refuses to surface the memory and the next retrospective is prompted to reconfirm or delete it. Stale knowledge is worse than no knowledge.
- **Write path:** memories are written only through the retrospective review gate (§7.13). Agents never write directly to the memory store from inside a Task; that's the "drift from auto-learned knowledge" risk (§12).
- **v1 deferral:** memory is not in the Phase 1–5 scope — it requires the retrospective process to exist first. v1 Missions run with skills only.

---

## 8. Primary user flows

### 8.1 Create and run a Mission

1. Operator clicks *New Mission*, fills in goal, repo list, backend + agent ID, concurrency=10, budget=$200, auto-merge=on for diffs ≤20 lines.
2. Clicks *Plan*. Planner emits 87 Tasks. Operator removes 3 irrelevant repos; clicks *Start*.
3. Dispatcher claims 10 Tasks, spawns 10 backend sessions.
4. Agents run; webhooks drive Tasks to `turn_ended`.
5. Gate opens PRs, polls CI, auto-merges 71, flags 12 for review, abandons 4.
6. Mission hits `completed`. Console shows: 71 merged, 12 awaiting review, 4 abandoned, $163 spent.

### 8.2 Budget pause

1. Large Mission burns through tokens faster than expected.
2. At 80% budget, Mission auto-pauses. Operator receives notification.
3. In-flight Tasks complete normally; no new dispatches.
4. Operator reviews burn rate, raises budget, resumes.

### 8.3 Retry with feedback

1. Task reaches `awaiting_ci`; CI fails on a lint rule.
2. Gate sends a follow-up turn: "CI failed, here is the lint log, please fix."
3. Agent updates the PR; new CI runs; passes.
4. Gate merges. Ledger records both turns and both CI runs.

### 8.4 Swap to gateway

1. Operator's security review says "no code leaves the network."
2. Operator stands up AgentStep Gateway internally, sets `FORGE_BACKEND=gateway` and `GATEWAY_URL=https://gateway.internal`.
3. Existing Missions resume against the gateway. Ledger shows the backend change as an event.
4. New Missions use the gateway by default; old Mission records remain intact.

---

## 9. Success metrics

**Adoption (90 days post-launch):**
- 1,000 GitHub stars.
- 50 self-hosted deployments reporting via opt-in telemetry.
- 5 public case studies.

**Product health:**
- Time-to-first-Mission < 10 minutes (measured from install).
- Median Mission success rate (Tasks merged / Tasks dispatched) > 60% for dependency-bump Missions.
- Tick P95 *duration* < 2s at 500 live Tasks (cadence is fixed at 60s; see §7.11).
- Zero Ledger data loss across rolling deploys (verified by integration test).

**Ecosystem:**
- Both adapters (MA, gateway) pass the shared contract test suite on every PR.
- Community contributions: ≥ 5 external PRs merged in first 90 days.

---

## 10. Constraints

- **Managed Agents API surface must support** session create, turn append, event stream, webhook with HMAC, usage accounting. If any is missing at launch, Forge's roadmap slips to match MA's. See §12 for the gating risk.
- **Gateway must remain API-compatible with MA** within the subset Forge uses. Contract tests enforce this; divergence is a release blocker.
- **Storage via libSQL/Turso** — one dependency, not two. No Redis, no Postgres, no queue broker in v1.
- **Standalone repo, deployed to Google Cloud Run.** Forge is its own OSS project — not embedded in another app. Deployment target is Cloud Run (stateless containers) with Cloud Scheduler driving the tick. See §15 for the concrete stack.
- **No merge without policy.** Forge never merges a PR unless the Mission's auto-merge policy explicitly allows it for that diff shape.

---

## 11. Milestones

- **Phase 0 — Schema + CRUD** (week 1): tables, read/write APIs, Console scaffolding. No execution.
- **Phase 1 — Single-Task end-to-end on MA** (weeks 2–3): rule-based Planner; dispatcher that calls `sessions.create` with repo resource + GitHub MCP vault; tick polls `sessions.events.list` per running Task and writes to the Ledger; open PR via the MCP tool; poll CI via GitHub Checks; no auto-merge.
- **Phase 2 — Gate maturity** (weeks 4–5): auto-merge policies, retry-with-feedback, timeouts, budget pause.
- **Phase 3 — Gateway adapter** (weeks 5–6, parallel to late Phase 2): gateway adapter + shared contract test suite, `FORGE_BACKEND` swap verified end-to-end. Decoupled from Gate maturity so neither blocks the other.
- **Phase 4 — Planner power** (weeks 7–9): LLM Planner, DAG dependencies, Mission templates.
- **Phase 5 — Scale polish** (weeks 10+): GitHub CI webhook, per-repo concurrency caps, OTel, opt-in telemetry, first hosted beta.

---

## 12. Risks

- **MA API rate limits at high fan-out.** Resolved the prior "is the API surface there" gating unknown (see [`docs/ma-api-audit.md`](./ma-api-audit.md)); replaced by a scale concern. MA caps list/get operations at 600 RPM and session/agent/vault creates at 60 RPM per organization. At our stated 500-concurrent-Task target we have headroom; at 2000+ Tasks we'd need to move from paginated polling to SSE streaming (which forces an always-on worker and breaks scale-to-zero). *Mitigation:* stay on polling for v1, measure actual per-tick call volume in the first real Mission, re-plan the stream path only if we hit 80% of the 600 RPM cap.
- **Cost at fleet scale on hosted MA.** Missions can be expensive. *Mitigation:* budget primitives are central; docs honestly compare MA cost vs. gateway-on-cheap-sandboxes.
- **Anthropic ships their own orchestration.** *Mitigation:* Forge's moat is open source + multi-engine via gateway + an auditable ledger — differentiation that survives adjacency.
- **API drift between MA and gateway.** *Mitigation:* contract test suite owned by the gateway repo, run in Forge CI on every PR.
- **Community momentum is a product.** *Mitigation:* budget explicitly for docs, videos, launch, and issue triage — not just code.
- **Drift from auto-learned knowledge.** The retrospective process (§7.13) produces proposed skill diffs and memory entries from Ledger evidence. If Forge ever lets those proposals apply without human review — or if operators rubber-stamp them — every Mission after that point runs against an agent whose instructions have silently changed, and a retrospective that was wrong (stale evidence, misread pattern, rare-event overgeneralisation) becomes load-bearing policy. This is extraordinarily hard to trace after the fact, because the Ledger faithfully records the *application* of the change but not the *quality of the decision that applied it*. *Mitigation:* the review gate is non-negotiable — there is no "auto-apply" mode, even behind a flag. Every accepted proposal lands as an explicit Ledger event with a reviewer identity, an evidence pointer back to the Ledger events that justified it, and a reversible diff. Retrospective output must be reviewable by a human who doesn't also supervise the Missions it would change.

---

## 13. Out of scope (v1)

- Hosted Forge SaaS (planned for after v1).
- SSO, RBAC, audit log export (enterprise tier, post-v1).
- IDE integration.
- Human-in-the-loop mid-Task intervention beyond retry/abandon.
- Non-coding Missions (doc writes, data jobs) — focus is code.
- Cost optimization across Mission classes (routing easy Tasks to cheaper models) — Phase 5+.

---

## 14. Open questions (resolved 2026-04-25)

1. **Mission ownership — user-scoped v1.** Every Mission belongs to the `user_id` that created it. The schema already enforces this (`missions.user_id NOT NULL`). Workspace/team scoping is a v2 enterprise concern; we won't add a `workspace_id` column or RBAC layer in v1. Once `better-auth` lands (Session 4), `user_id` maps to the authenticated user.

2. **Default auto-merge policy — off.** `auto_merge_policy` defaults to `null` on the schema (no policy = no auto-merge). Operators must explicitly provide a policy object with `enabled: true` plus diff-shape caps when creating a Mission. The Console's New Mission form will show auto-merge as an opt-in toggle, collapsed by default.

3. **Web-only for v1.** No CLI ships in v1. The Console + API surface covers all launch use cases. A CLI (`forge run`, `forge status`) is a fast-follow that wraps the same REST endpoints; no schema or API design changes needed to support it later.

4. **Operator webhook for v1 notifications.** Forge will fire a POST to `mission.webhook_url` (already a schema field via `webhook_secret`) on key lifecycle events: mission.completed, budget.auto_paused, task.failed. Payload is the Ledger event body. Slack is a template consumers can adapt from the webhook payload; we won't build a first-party Slack integration in v1.

---

## 15. Stack

Locked for v1. Chosen to keep Forge deployable as two small Cloud Run services against one remote libSQL database, with no durable-execution vendor dep.

### Services

- **`forge-web`** — Next.js (App Router). Hosts the Console, the public API, and the webhook receiver. Deployed as a Cloud Run service, autoscaling, scale-to-zero allowed. Handles traffic bursts from backend webhooks.
- **`forge-tick`** — small Node service exposing `POST /tick`. Deployed as a Cloud Run service, invoked by Cloud Scheduler every 60s. Does one tick of work (claim queued Tasks, run Gate, check budgets) and returns. Scale-to-zero between invocations.
- If sub-minute cadence is ever needed, `forge-tick` flips to `min-instances=1` and runs an in-process loop. No other code changes.

### Platform

- **Runtime:** Node 22 (LTS). TypeScript everywhere.
- **Deploy:** Google Cloud Run, both services in the same project, same region.
- **Scheduler:** Cloud Scheduler → HTTPS invocation of `forge-tick` with OIDC auth.
- **Secrets:** Google Secret Manager, mounted as env at deploy.
- **Logs:** pino → stdout → Cloud Logging.
- **Tracing:** OpenTelemetry SDK → Cloud Trace. OSS self-hosters can point at any OTLP collector.

### Data

- **Database:** libSQL / Turso (remote). Stateless containers, DB over HTTP — natural Cloud Run fit.
- **ORM:** Drizzle, with Drizzle Kit for migrations.
- **No** Redis, no queue broker, no additional datastore in v1.

### Web

- **Framework:** Next.js App Router. Route Handlers for the API and webhook endpoint.
- **UI:** Tailwind CSS + shadcn/ui + TanStack Table.
- **Live events:** Server-Sent Events (SSE) from `forge-web` for the Task detail page. Backend session events arrive via webhook → Ledger → SSE fan-out.
- **Auth:** better-auth (self-hostable, OSS-friendly). Single-user and workspace modes; v1 uses single-user.

### Integrations

- **Outbound HTTP:** plain `fetch` wrapped in a small retry helper with exponential backoff. No circuit breaker in v1.
- **GitHub:** Octokit. PR creation, Checks API polling in v1; GitHub webhook listener added in Phase 5.
- **Backend adapters:** one TypeScript interface (`createSession`, `sendTurn`, `cancelSession`), two implementations (`managed-agents`, `gateway`). Chosen per Mission; default via env.

### Quality

- **Testing:** Vitest (unit + integration), Playwright (Console smoke). Contract tests for adapters consumed as a shared package from the gateway repo and run in Forge CI.
- **CI:** GitHub Actions. Lint, typecheck, tests on every PR. Deploy to Cloud Run via `gcloud run deploy` on merge to `main`.
- **Local dev:** Docker Compose brings up libSQL locally; `pnpm dev` runs both services with live reload.

### What this buys us

- Two-service split separates latency-sensitive (webhooks) from batch (tick), but each service is small enough that one engineer can hold it in their head.
- Cloud Run + libSQL is roughly "a Postgres-shaped app without the Postgres." No infra to operate; scale-to-zero keeps cost near zero for OSS users who run it for their own fleet.
- Nothing on this list is vendor-exclusive. Self-hosters can deploy the same containers on Fly.io, Railway, or plain Kubernetes without code changes; libSQL runs embedded if they don't want Turso.

---

## 16. UI architecture

The Console is the operator's primary surface — for OSS self-hosters, the dashboard *is* the product. v1's first cut was correct as a CRUD scaffold but wrong as an ops surface: a status-column table for the Missions list, four-card grid plus tasks table for Mission detail, and a raw chronological event feed for Task detail. Three patterns from competitor research (Stripe Minions, Factory Missions, open-agents.dev) inform the redesign:

1. **Row density beats charts.** Fleet-scale visibility comes from making each row in the Missions list carry per-Mission progress, spend, ETA, and freshness — not from a separate analytics screen.
2. **Mission Control collapses three panels into one.** Tasks, timeline, and config live on one screen so the operator's eye doesn't move when triaging.
3. **The audit trail is a narrative, not a firehose.** Backend events get role-tagged (forge / model / agent / session), grouped by Task, with low-signal events (thinking, model spans) collapsed by default.

What we explicitly do **not** copy: Factory's AI-generated inline UI (Mermaid diagrams the agent draws on the fly — undermines auditability), Stripe's no-dashboard philosophy (works internally with a heavy Slack culture; doesn't translate to OSS self-hosters), open-agents' "infinite cloud agents" framing (Forge's value is bounded, finite, budgeted work).

### 16.1 Three primary screens

| Screen | URL | Purpose |
|---|---|---|
| **Missions list** | `/missions` | Fleet-scale ops surface. One row per Mission, each row carries everything the operator needs to triage. |
| **Mission Control** | `/missions/[id]` | Single screen showing every Task, the live event timeline, and the Mission's budget/config sidebar. The operator's home base. |
| **Plan preview** | `/missions/[id]/plan` | Editable draft of the Planner's output, gated between *Plan* and *Start*. PRD §7.3 specs this; v1 skipped the UI. |

Task detail (`/missions/[id]/tasks/[id]`) becomes a focused drill-down accessible from Mission Control — same primitives, no Mission chrome, single Task scoped.

### 16.2 Missions list — row density

Each row carries:
- Name + status badge
- **ProgressPill** — the dense `42% · 12/30 done · 3 in flight · $4.20 · ETA 2m` density open-agents popularised. Shape: `done/abandoned/failed counts | in-flight count | total spend | ETA or last-event-age`.
- Backend + concurrency cap + planner strategy as muted tags
- Last event timestamp (relative — "3s ago")
- A 30-bar Task-state-over-time sparkline (deferred to Phase 2)

No filtering UI in v1; the table is sortable by created-at descending and that's it. Filters arrive when the row count crosses ~50.

### 16.3 Mission Control — single-screen ops

```
┌────────────────────────────────────────────────────────────────────┐
│ Mission name [status]          Pause / Resume / Cancel  msn_...   │
├────────────────────────┬─────────────────────────────────┬─────────┤
│ Tasks                  │ Timeline                        │ Sidebar │
│                        │                                 │         │
│ ┌──────────────────┐   │ ▸ forge: planner.emitted        │ Goal    │
│ │ acme/api         │   │ ▸ forge: mission.started        │ ━━━━━   │
│ │ awaiting_review  │   │ ▾ Task 1 acme/api               │ Budget  │
│ │ 42 events 12/30  │   │   ▸ session: status_running     │ ▓▓▓░    │
│ │ branch · PR #14  │   │   ▸ agent: tool_use bash        │ Backend │
│ └──────────────────┘   │   ▾ agent: message              │ GitHub  │
│ ┌──────────────────┐   │     "Bumped fast-glob..."        │         │
│ │ acme/web         │   │   ★ agent: mcp_tool_result      │ Actions │
│ │ running          │   │     PR #14 opened               │         │
│ │ 18 events 5/12   │   │ ▾ Task 2 acme/web               │         │
│ │ branch           │   │   ...                           │         │
│ └──────────────────┘   │                                 │         │
└────────────────────────┴─────────────────────────────────┴─────────┘
```

- **Left column (~30%):** Tasks as cards. Each card: repo (mono), status badge, ProgressPill (compact), branch name + PR link if open. Clicking a card filters the Timeline to that Task (URL search-param `?task=tsk_...`).
- **Center column (~50%):** Live, role-tagged Timeline. Events grouped by Task, with collapsible groups. Within a Task: `agent.thinking` and `span.model_request_*` are collapsed by default; `agent.message`, `agent.mcp_tool_result`, and lifecycle events (`session.status_*`, `dispatcher.*`, `mission.*`, `ci.*`) are expanded. Each event card is a `RoleTaggedEvent`.
- **Right column (~20%):** Goal text (with `TemplateText` chips), Budget gauge (USD + tokens with threshold marker), Backend + Agent ID, GitHub config, lifecycle action buttons stacked.

Live updates via Server-Sent Events (`GET /api/missions/[id]/events/stream`) — the Timeline appends new events without a page reload. Already on the PRD §15 "Web > Live events" line; v1's first cut implements it as a `setInterval` poll and upgrades to true SSE in Phase 2.

### 16.4 Component primitives

The redesign is driven by a small set of named, reusable components. Building these first — then composing screens from them — makes the redesign cheaper, the polish more consistent, and the eventual extraction (CLI / external dashboards) trivial.

| Component | Purpose |
|---|---|
| `TemplateText` | Renders text with `{{var}}` patterns highlighted as inline chips. Already shipped (commit `7574de9`) — used in Goal cards, Plan preview, Retrospective output. |
| `MissionStatusBadge` | Status badge with the right variant for `draft / planning / running / paused / completed / cancelled`. |
| `TaskStatusBadge` | Same shape for the 11 Task statuses. |
| `ProgressPill` | Per-Task density: done/total, in-flight count, spend, ETA or last-event-age. Two variants: `compact` (table cell) and `expanded` (Mission Control card). |
| `RoleTaggedEvent` | One Ledger event card. Knows the four roles (forge / model / agent / session) and renders an appropriate label, colour, and default expand-state. |
| `Timeline` | Wraps `RoleTaggedEvent` with grouping by Task, collapsible Task sections, and the SSE subscription. |
| `BudgetGauge` | USD + tokens with a marker at the pause threshold. |

### 16.5 Role tagging — making the firehose readable

Every Ledger event maps to one of four roles:

| Role | Events | Default state |
|---|---|---|
| **forge** | `planner.*`, `mission.*`, `dispatcher.*`, `task.*`, `ci.*` | Always expanded — these are decisions Forge made. |
| **session** | `session.status_*`, `session.error` | Expanded for terminal / error transitions, collapsed for routine running ↔ idle. |
| **agent** | `agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `agent.mcp_tool_use`, `agent.mcp_tool_result`, `user.message`, `user.tool_confirmation`, `user.custom_tool_result` | `message` and `mcp_tool_result` expanded (signal); `thinking`, `tool_use`/`tool_result` pairs collapsed. |
| **model** | `span.model_request_start`, `span.model_request_end` | Collapsed by default. Model usage rolls up into the Task's spend display. |

`mcp_tool_result` events that contain a github.com PR URL get a star marker — they're the moment a Task transitions to `awaiting_ci`.

### 16.6 Phasing

- **Phase A (this redesign):** Mission Control rebuild + ProgressPill + RoleTaggedEvent + Timeline grouping. List view gets ProgressPill column.
- **Phase B (next):** Plan preview screen as the gate between Plan and Start. Live updates upgrade from poll to SSE.
- **Phase C (Phase 5 territory):** GitHub-issue-reaction dispatch (lowest-friction front door, lifted from Stripe's emoji pattern). Sparklines on the Missions list.

### 16.7 Out of scope for the UI redesign

- Slack integration. Operator-facing webhook is enough for v1.
- AI-generated charts/diagrams inline in the Console. Auditability over cute.
- Multi-tenant workspace switcher. Single-user mode is v1.
- Dark mode toggle. shadcn ships dark-mode CSS; the toggle wires up later.
- Mobile-first layouts. Console is a desktop tool.
