# Forge — Capability Layer PRD

**Status:** Draft for review
**Date:** 2026-07-28
**Supersedes (proposed):** the positioning and requirements framing in `docs/forge-prd.md` (2026-04-24)
**Reflects:** `main` @ `0e02db0` — 763 tests, deployed

---

## 1. Thesis

Anthropic's Managed Agents (CMA) runs **one agent session**: create it, append turns, read
events, cancel it. It is a good execution substrate and it has no opinion about what happens
around a session.

Forge is the set of capabilities that turn one session into a **fleet you can walk away from**.
Everything Forge does is in service of a single claim:

> Start a Mission, close the laptop, and come back to merged PRs, a bounded bill, and a record
> of every decision — with anything ambiguous waiting in one queue.

Forge is not an agent, a sandbox, an IDE plugin, or a chat UI. It is the orchestration layer
that makes unattended agent work safe enough to be worth starting.

## 2. The layer boundary

| Concern | CMA (substrate) | Forge (this product) |
| --- | --- | --- |
| Run an agent turn | ✅ | — |
| Sandboxed execution | ✅ | — |
| Report token usage | ✅ | — |
| Decide *which* agents run, and how many | — | ✅ |
| Stop paying when a budget is hit | — | ✅ |
| Decide what must be true before work merges | — | ✅ |
| Keep one record across different engines | — | ✅ |

CMA reports; Forge enforces. That distinction is the product.

**Portability is a first-class requirement, not a hedge.** Forge speaks to CMA, the AgentStep
Gateway, and Gemini through one `BackendAdapter`, and normalises all three into one ledger
schema. An operator changes engines with a config flag and keeps their audit trail. No
single-vendor competitor can offer this by construction.

## 3. Who this is for

**Platform and DevEx engineers at mid-to-large orgs** who own the "upgrade every service"
problem. They are comfortable with CI, GitHub Apps and budgets-as-policy. They do not want
magic; they want to explain to their security team what the agent is allowed to do, and to
their finance team what it will cost.

The buying question is never "is the agent smart enough". It is **"what happens when it is
wrong at 3am, and how do I prove what it did".**

## 4. Capabilities

The orchestration loop runs every 60 seconds:

```
poller → guardrails → ci → verify → ai-review → auto-merge → budgets → reconciler → dispatcher → memory-expiry
```

### 4.1 Fleet decomposition and scheduling
A Mission decomposes into Tasks via a planner (rule-based or LLM). The dispatcher claims work
under a `concurrencyCap` rolled up across a container/leaf family, so a repo's issue-missions
share one pool of slots. Tasks carry dependencies; a fix waits on its reproduce, and a failed
dependency cascades rather than blocking forever.

### 4.2 Durable state across ephemeral sessions
Fifteen task statuses, advanced by a reconciler, with stall sweeps for anything wedged. Backend
session references are persisted, so state survives cold starts and scale-out — a session that
dies mid-flight is reconciled, not lost.

### 4.3 Backend portability and a normalised ledger
One adapter interface over three engines. Events are pulled, normalised, deduplicated by
`(taskId, sourceEventId)`, and stored durably. **This is the highest-value differentiator and
the least exposed.**

### 4.4 Enforcement
- **Budgets** at mission-family scope: a soft stop pauses; a hard stop cancels live sessions and
  verifies the cancel landed.
- **Guardrails**: turn caps, token caps, no-progress detection, gate-stall sweeps.
- **Retry caps** on CI, self-verify and AI-review, each escalating rather than looping.

CMA will run until the bill says otherwise. Forge is where "stop" lives.

### 4.5 Gates and human-in-the-loop
- **Plan approval before dispatch** — nothing runs until a human starts it.
- **Tool-level blocking** — four tools auto-confirm; merge, force-push and branch-delete halt
  for a person.
- **CI → self-verify → AI-review → merge**, with the merge decision delegated to GitHub branch
  protection rather than reimplemented.
- **One escalation queue** (`needs_human`) with Approve and Dismiss, where an approval is bound
  to the reviewed head SHA and expires when the work changes.

### 4.6 Software-delivery integration
PR opening, CI observation, auto-merge armed through GitHub's native mechanism, `@forge` issue
triggers, per-repo policy, and a retrospective/proposal loop.

## 5. Positioning

**Against Factory, Devin, Copilot cloud agent, Codex.** Those are single-vendor stacks: their
runtime, their orchestration, their record. Forge separates the layers. Concretely, Factory's
Sessions API — the only route to transcripts — is restricted to allowlisted organisations,
while the equivalent CMA primitives are generally available. Forge's ledger spans three engines;
theirs cannot span one.

**Against Anthropic.** Complement, not competitor. Forge runs *on* Managed Agents and makes it
usable for fleet work. CMA competes with Factory's *runtime*; Forge competes with Factory's
*Mission Control*.

**Against Dependabot and Renovate.** They are the mature answer for deterministic fleet change,
and they set the bar Forge is measured against: merge gating delegated to the code host, policy
expressed as versioned config, and one durable object showing everything pending. Forge now
does the first. The second and third are roadmap.

## 6. Honest maturity

| Area | State |
| --- | --- |
| Tick loop, budgets, guardrails | Solid, exercised |
| Ledger and dedup, adapter seam | Solid |
| Task state machine | Solid after 2026-07-27 gating work |
| Auto-merge | **Shipped, never run in production** |
| Policy configuration | **One commit old** |
| `@forge` end-to-end | **Never run end to end** |

## 7. Known gaps

These are tracked, not hidden.

1. **The ledger has no read API.** Auditability is the headline claim and it is reachable only
   through the web UI. `GET /missions/{id}/ledger` is the single highest-value endpoint in the
   product.
2. **No machine credential.** `apiAuth()` reads the same session cookie as `withAuth()` — there
   is no API key, no service account. The REST surface cannot be driven from CI.
3. **Auto-merge does not reach the `@forge` path.** Missions created from an issue have no
   container, so the policy never resolves. The feature is half-landed.
4. **`requireHumanApproval` forces a 30-minute detour** through the stall sweep before a task
   becomes approvable.
5. **Mission creation is not repo-gated.** `targetRepos` is regex-validated only, and the
   dispatcher clones with a shared token. Highest-severity open item.
6. **Policy is not versioned config.** Per-repo JSON in a database, not an inheritable file in
   the repo. This is the largest structural gap against Renovate.

## 8. Success metrics

Instrument the walk-away claim, not activity:

- **Unattended completion rate** — Missions reaching a terminal state with no human action
  between Start and merge.
- **Escalation precision** — of tasks reaching `needs_human`, the share a human approves
  unchanged. Low precision means the gates cry wolf.
- **Budget adherence** — Missions completing within budget; hard stops that fired without a
  verified cancel (target: zero).
- **Time in `needs_human`** — the queue's job is to drain.
- **Backend portability, proven** — at least one operator running two engines against one
  ledger. Until that happens, portability is a claim.

## 9. Out of scope

Being an agent runtime, a sandbox, an IDE plugin, or a chat UI for single-task work. Generalising
beyond software delivery: Forge's gates assume a cheap mechanical verifier (CI) and a versioned,
revertible artifact (a PR). Domains with those properties — IaC, data pipelines, docs-as-code —
are plausible later; open-ended knowledge work is not, because every task would land in
`needs_human` and the operator becomes the bottleneck the product exists to remove.

## 10. Open questions

1. Does portability get exercised, or is one engine the reality? Metric §8 answers this.
2. Is policy-as-code (§7.6) required for the first serious customer, or does per-repo config hold?
3. Does `requireHumanApproval` want to be four-eyes? Today it permits self-approval, stated
   plainly in the UI. Separation of duties needs an org and role model that does not exist.
4. What is the first non-code domain worth testing §9's boundary against?
