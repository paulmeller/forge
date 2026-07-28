# Forge — Competitive Gap Analysis

**Date:** 2026-07-28
**Forge state:** `main` @ `0e02db0` — 763 tests, deployed
**Comparison set:** Devin (Cognition), Factory.ai, GitHub Copilot cloud agent, OpenHands,
Sourcegraph Batch Changes, Renovate (Mend)

## Method

Four research passes against official documentation, fetched rather than recalled — including
Factory's actual OpenAPI document (36 paths), Renovate's LICENSE file, and vendor trust centres.
Findings are marked VERIFIED where an official source was read, and flagged UNCERTAIN otherwise.
Forge's own positions were checked against the codebase, not against its PRD.

Where an earlier claim in this analysis proved wrong, it is corrected inline rather than removed.

---

## 1. The one-page answer

**Forge's defensible position is a single combination:** open licence, self-hostable, pluggable
backend engines, one normalised ledger across them. The research found no product that offers all
four. That is the whole moat.

**It is currently unproven and unexportable.** Nobody has run two backends against one ledger, and
the ledger has no read API — so the differentiator is invisible outside the web UI.

**The weakest dimension is observability**, which the research identified as the single factor that
most determines whether an unattended fleet orchestrator is operable at scale. Forge has no
OpenTelemetry, no alerting, and no machine-readable run history.

**The most surprising gap is scheduling.** Four of six competitors now ship first-party recurring
triggers. Forge cannot express "every Monday, check these 140 repos" — the tick advances existing
missions but nothing creates them.

---

## 2. Scorecard

Legend: **▲** ahead · **=** parity · **▼** behind · **✗** absent

| Dimension | Forge | Notes |
| --- | :---: | --- |
| Self-host + open licence | ▲ | Peers: Renovate (AGPL-3.0), OpenHands (MIT) only |
| Multi-backend + one ledger | ▲ | **No competitor offers this combination** |
| Cost-model exit | ▲ | Peers: Renovate, OpenHands only |
| Merge gating delegated to code host | ▲ | Factory and Codex have no auto-merge at all |
| Escalate-to-human as a queue | ▲ | Field-wide weakness; Forge routes 4 reasons into one queue |
| Tool-level allowlist | ▲ | Blocks merge/force-push/branch-delete by default |
| Budget hard-stop | = | **Was ahead; no longer.** See §3 correction |
| BYO model | ▼ | Inherited from the CMA agent; no picker |
| MCP | = | MCP-*aware* (gates tool calls), not MCP-*configuring* |
| Onboarding conventions | = | AGENTS.md + skills, matching the field's convergence |
| Fleet rollout mechanics | ▼▼ | Far behind Batch Changes. Largest capability gap |
| Scheduled triggers | ✗ | 4 of 6 competitors have first-party recurring triggers |
| Observability / OTel | ✗ | No instrumentation at all |
| Alerting | ✗ | Ledger and logs only |
| Run-history API | ✗ | Ledger is UI-only |
| Machine credential | ✗ | `apiAuth()` reads the same cookie as `withAuth()` |
| Org / role model | ✗ | Ownership is `userId` |
| Compliance certifications | ✗ | Structural — see §5 |

---

## 3. Corrections to earlier claims in this session

**Budget enforcement is no longer differentiated.** I previously said Devin and Factory were
Forge's only peers on budgets that halt live work. That is now wrong: GitHub shipped verified
hard-stops in its **June 2026 AI Credits overhaul** (enterprise / cost-centre / user level), and
OpenHands added org budget limits in **v0.24.0**. This was a differentiator; as of 2026 it is table
stakes.

**Forge's webhook advantage is narrower than stated.** `docs/ma-api-audit.md` is explicit that
Managed Agents does not push events — Forge polls `GET /v1/sessions/{id}/events` every 60s. The
genuine webhook strength is GitHub ingest, not agent-run events.

**MCP is table stakes, not a gap to chase.** Five of six competitors have first-party MCP. Forge
observes and gates MCP tool calls but cannot configure servers. Worth knowing; not worth
prioritising.

---

## 4. Dimension detail

### 4.1 Deployment and licensing — Forge ▲

Only **Renovate** (AGPL-3.0 core) and **OpenHands** (MIT core) offer a genuinely free, zero-vendor-layer
self-host path. Everything else gates it:

- **Devin** is *retreating* from self-hosting — the self-hosted deployment is in maintenance mode and
  being sunset. Outposts (alpha→GA ~July 2026) runs execution on customer hardware but inference,
  planning and secrets stay in Cognition's cloud, **billed through Cognition's ACU meter regardless**.
- **Factory** offers hybrid and airgapped tiers, but the Droid binary is proprietary even on customer
  infra, and auth relays through `relay.factory.ai`.
- **Sourcegraph** has genuine customer-deployed executors, but they are Enterprise-gated — and the
  licensing trajectory is *closing*: relicensed off Apache in 2023, core repo went fully private in
  August 2024.
- **Copilot** has no meaningful self-host story; GHES is explicitly excluded from the cloud agent.

### 4.2 Fleet mechanics — Forge ▼▼ (largest gap)

Sourcegraph Batch Changes has named, config-driven primitives Forge has no equivalent for:

| Batch Changes | Forge |
| --- | --- |
| `rolloutWindows` — `{rate, days, start, end}` throttling create/update/close | `concurrencyCap` only |
| Publish states `true`/`false`/`draft`, per-repo glob override | none |
| `transformChanges` — split one repo's diff into multiple changesets | none |
| `repositoriesMatchingQuery` — one change across a repo *query* | explicit `targetRepos` list |
| Per-batch GraphQL view of every changeset's state | per-repo pages only |

Scale claim: "tens of thousands of changesets" internally tested. Forge's model is per-repo-container
caps.

Worth noting the field is otherwise weak here — **Copilot documents outright that it "cannot make
changes across multiple repositories in one run"**, and Devin/Factory treat multi-repo as "run more
sessions". But **OpenHands Enterprise shipped an "Agent Control Plane" in May 2026** running workflows
"across many repositories in parallel, with built-in scheduling, retries, and state management" — a
direct competitor occupying Forge's position with a larger community.

### 4.3 Cost model — Forge ▲

Only Renovate and OpenHands let a customer fully exit vendor billing. Notable: Devin bills through
its ACU meter even when execution runs on your hardware; Factory's BYOK removes model markup but
still requires a paid subscription underneath.

### 4.4 Extensibility and lock-in — Forge ▲ on the axis that matters

The research's conclusion: *"No product surveyed combines (a) full self-host / open licence,
(b) pluggable backend engines, and (c) one normalized ledger across them."*

Near-misses are instructive. OpenHands has swappable **sandboxes** (`RUNTIME`: docker / process /
remote / Apptainer) — runtime isolation, not distinct agent backends under one record. GitHub has
genuine **agent-swap** (Claude and Codex as first-party agents) but proprietary with GitHub's meter
behind it. Sourcegraph's new agentic layer supports BYOK agents — Enterprise-licensed.

Nobody has a clean vendor-neutral export format: Devin's ATIF, GitHub's audit-log schema, OpenHands'
Pydantic event stream are all proprietary-but-documented. **Forge's normalised ledger schema could be
that format** — if it were readable.

### 4.5 Security and compliance — Forge ✗ on certification, mixed on substance

**Certifications.** Devin and Sourcegraph have SOC 2 Type II + ISO 27001:2022 VERIFIED. Copilot
inherits tier-level SOC 2 Type I + ISO 27001. Factory's claims are **internally inconsistent** — its
marketing page says SOC 2 Type I while an enterprise doc says SOC 2 + ISO 27001 unqualified; worth
raising with a buyer. OpenHands and Renovate/Mend have **no completed certifications** (Mend's trust
page says "working towards"). FedRAMP is absent or pending everywhere; HIPAA/BAA undocumented across
all six.

Forge has none and structurally cannot — it is a codebase, not a company. The counter is that
self-hosting moves the compliance boundary: your SOC 2 covers it because data never leaves your
infrastructure. Strong for a platform team, weak on a procurement form.

**Substance, where Forge does better than its certification story suggests:**
- Secrets go through **vault IDs** (`githubVaultId`, `FORGE_MA_DEFAULT_VAULT_ID`), not env injection.
- The **tool allowlist** blocks merge, `push --force` and branch-delete by default — stricter than
  Factory's sandbox (opt-in/beta) and OpenHands (**no documented egress control at all**).
- Sandbox isolation is inherited from CMA rather than owned.

**Counterweight, stated honestly:** a five-hop cross-account authorization chain was found and closed
in this codebase on 2026-07-27. Ungated `targetRepos` on mission creation remains open.

### 4.6 Triggers — Forge ✗ on scheduling

| Trigger | Forge | Field |
| --- | :---: | --- |
| Web UI | ✓ | universal |
| Issue comment | ✓ `@forge` | Devin, Factory, Copilot, OpenHands |
| CLI | ✗ | Devin, Factory, Copilot (`gh agent-task`), OpenHands, Sourcegraph, Renovate |
| Slack | ✗ | Devin, Factory, Copilot, OpenHands |
| Jira / Linear | ✗ | Devin, Copilot (both); Factory (Linear); OpenHands (Jira) |
| **Scheduled / recurring** | **✗** | **Devin, Factory, Copilot, OpenHands, Renovate** |
| API | partial | cookie-auth only |

Scheduling used to be a differentiator and is now close to table stakes. Sourcegraph is the only
other product without it — and its FAQ explicitly pushes customers onto their own CI as a workaround.

For a product whose thesis is *unattended fleet work*, "run this across the estate every Monday" being
inexpressible is the most conspicuous single gap after observability.

### 4.7 Observability — Forge ✗, and this is the one that matters most

The research's own synthesis: observability *"is the dimension that most determines whether the
product is operable at scale"* — because at fleet scale, without default-on exportable telemetry and
failure alerting, an operator "has no way to detect a stuck run, a silent budget overrun, or a
systemic failure pattern until a human happens to notice."

| | Forge | Field |
| --- | --- | --- |
| OpenTelemetry | **none** | Factory, OpenHands, Sourcegraph, Renovate — all opt-in, none default-on |
| Alerting | **none** | Sourcegraph outgoing webhooks; Devin automation notifications; Factory/Renovate/OpenHands punt to customer |
| Run history API | **none** | Devin Audit Logs API (≥1yr); Copilot SIEM streaming |
| Dashboards | UI rollups | spend/adoption analytics common; no DORA anywhere |

The mitigating fact is that Forge's **ledger already contains what OTel would carry** — normalised,
deduplicated, per-task. It is the data model everyone else is trying to reconstruct from traces. It
simply has no exit.

**The wedge the research identified, verbatim:** *"none of the six products pair 'runs unattended
across many repos' with 'verifiable default network isolation + operator-facing failure alerting' as
a shipped, on-by-default combination."*

### 4.8 Onboarding — Forge =

The field has converged on one shape: a repo-committed, human-authored config supplying the toolchain
the agent cannot infer — Devin Blueprints, Factory's AGENTS.md, `copilot-setup-steps.yml`, OpenHands
`.openhands/setup.sh`, Sourcegraph's `steps.container`, Renovate's onboarding PR.

Forge has AGENTS.md support and a skill loader, which is parity. Renovate is the only product with a
formal *safe-first-PR* onboarding gate (it makes no changes until the onboarding PR is merged) — a
pattern worth stealing.

---

## 5. Gaps ranked by impact

**Tier 1 — undermines the core claim**

1. **Ledger has no read API.** Auditability is the headline positioning and the differentiating
   artifact, reachable only through a browser. `GET /missions/{id}/ledger` is the single
   highest-value endpoint in the product.
2. **No machine credential.** `apiAuth()` reads the session cookie, so nothing is CI-drivable. The
   REST surface is shaped like an API and usable only by the app.
3. **Multi-backend is unproven.** Nobody has run two engines against one ledger. Until someone does,
   the moat is a claim.

**Tier 2 — blocks the use case**

4. **No scheduled mission creation.** Unattended fleet work that cannot be scheduled.
5. **No alerting.** Failure, stall and budget-breach events reach the ledger and nothing else.
6. **Fleet rollout mechanics.** No rate limiting, no scheduling windows, no staged rollout, no
   cross-repo status view.

**Tier 3 — competitive hygiene**

7. No OTel instrumentation. 8. No org/role model. 9. No CLI. 10. Model choice inherited, not offered.

**Not worth chasing:** MCP server configuration, model pickers, and certification programmes — the
first two are becoming baseline and neither is why anyone would choose an open orchestrator; the
third is unavailable to a codebase.

---

## 6. Recommended sequence

1. **`GET /missions/{id}/ledger` + a machine credential.** Together these make the moat visible and
   CI-drivable. `apiAuth()` already returns `[ApiUser, null]`, so a token path slots in beside the
   cookie without touching call sites. Smallest work, largest positioning gain.
2. **Prove two backends, one ledger** — a documented, repeatable demo. Converts the central claim
   from assertion to evidence.
3. **Scheduled missions.** The tick already runs every 60s; this is a mission-creation trigger on a
   cron, not new infrastructure.
4. **Alerting on failure / stall / budget breach.** The events already exist in the ledger; they need
   an outbound path.
5. **Steal `rolloutWindows` from Batch Changes.** Rate-limited, scheduled rollout is the most-cited
   fleet primitive and Forge has nothing like it.

Items 1 and 2 are the difference between having a moat and being able to point at one.
