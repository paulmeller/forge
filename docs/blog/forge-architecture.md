# Forge: an architecture for gated agent fleets

Coding agents are good at writing code and bad at knowing when to stop. Point one
at a repository and it will produce a diff; point ten at ten repositories and you
have a management problem — which of those diffs is safe, which is stalled, which
is quietly burning budget, and which one merged something nobody read.

Forge is our answer to that problem. It is not another place to run an agent. It
is the layer that decides what an agent's output has to survive before it counts
as done, and the record of what actually happened.

This post describes how it is built.

---

## What Forge is

Forge dispatches coding agents across GitHub repositories and gates their output
behind a pipeline of checks. An operator gives it a goal — "fix issue #47 in
`acme/api`" — and Forge takes it from there: it creates a sandboxed agent
session, hands it the repository, watches it work, opens the pull request,
runs the change through CI and review gates, and either merges it or escalates
it to a human with a reason.

The design rests on three commitments:

**Nothing merges without passing a gate.** Every path to `merged` runs through
CI, and optionally through self-verification and AI review. There is no code
path that moves a task to merged because an agent said it was finished.

**Nothing is silently dropped.** Work that cannot proceed escalates to a human
with a specific reason, rather than disappearing into a terminal failure state.

**Everything is recorded.** Every state change, tool call, model request and gate
decision is written to an append-only ledger. If you want to know why a change
merged, the answer is a query, not an archaeology exercise.

---

## The object model: missions, tasks, and gates

Forge has two units of work.

A **mission** is an operator's intent: a goal, a set of target repositories, a
budget, and a set of gate policies. Missions come in two shapes. A *campaign*
targets one or more repositories directly. A *container* is a per-repository
envelope that owns budget and concurrency for the issue work beneath it, and
holds no tasks of its own.

A **task** is one agent session against one repository. Tasks carry the state
machine — fourteen statuses, each one a distinct fact about where the work
stands:

```
queued → dispatching → running → turn_ended
       → awaiting_ci → awaiting_verify → awaiting_ai_review
       → ready_to_merge → merging → merged

  terminal: merged · resolved · needs_human · abandoned · failed
```

The statuses matter more than they might appear. `turn_ended` is not `done` — it
means the agent finished a turn, which is a claim about the model's output, not
about the work. `needs_human` is not `failed` — it means Forge did everything it
could and a person now owns the decision. Keeping those distinct is what lets the
pipeline act correctly on each one.

Gate configuration resolves through the mission family: an issue-level task reads
its AI-review and self-verify flags from its container, so policy is set once per
repository rather than per task. The resolution is a live lookup, not a value
copied at creation time — change the policy and in-flight work picks it up.

---

## The tick

Forge has no message queue and no worker pool. It has a single idempotent
function that runs every sixty seconds and moves whatever is ready to move.

```
poller      ingest backend events, advance task state
guardrails  halt runaway tasks (turns, tokens, no-progress)
ci          check PR status; feed failures back to the agent
verify      self-verification against acceptance criteria
ai-review   independent review of the diff
auto-merge  merge what has passed every enabled gate
budgets     pause or hard-stop missions over budget
reconciler  open PRs, settle finished work, escalate stalls
dispatcher  claim queued tasks and start agent sessions
memory      expire stale memories
```

Order is deliberate. The poller runs first so every later stage sees this tick's
state. The dispatcher runs late so it claims work against a settled picture.
Budgets run before the reconciler so a mission over its ceiling stops before more
work is created.

Each stage is wrapped so a failure in one cannot take down the others — a
guardrail that throws does not prevent CI from being checked. Every stage returns
a structured result, so a single tick reports exactly what it did:

```json
{
  "dispatcher": { "missions": 4, "claimed": 1, "dispatched": 1, "failed": 0 },
  "ci":         { "tasksChecked": 2, "retried": 1, "stillPending": 1 },
  "reconciler": { "prsOpened": 1, "gatesEscalated": 0, "tasksAbandoned": 0 },
  "budgets":    { "missionsChecked": 4, "paused": 0, "hardStopped": 0 }
}
```

Everything is a compare-and-swap. A stage that moves a task guards on the status
it observed, so two overlapping ticks cannot both act on the same row. Where a
stage performs a non-idempotent side effect — sending a turn to a live agent
session — it claims the row *before* the effect, not after.

---

## Gates

A diff earns its way to merge.

**CI** is the first and non-negotiable gate. Forge reads the check runs on the
pull request head. Green routes onward; failure routes back — the failing logs
are sent to the same agent session that produced the diff, and the agent gets a
chance to fix it. The retry budget counts *fix attempts*, keyed on the pull
request head SHA, so an agent working on a fix is not interrupted by the tick
that notices the same failure sixty seconds later.

**Self-verify** checks the change against the task's acceptance criteria, using a
different model from the one that wrote it. Checker and maker being distinct is
the point.

**AI review** is an independent read of the diff. Rejections return to the agent
with the reviewer's reasoning; persistent rejection escalates to a human rather
than looping.

**Auto-merge** is opt-in per repository and never applies to escalated work. A
task that reached `needs_human` is not auto-merge eligible no matter what happens
next, and any prior approval is cleared whenever a task leaves the state that
approval covered — an approval is for a specific diff at a specific SHA, not a
standing permission.

Between the gates sits the reconciler, which handles everything that does not fit
a clean path: opening pull requests for agents that pushed a branch but could not
open one themselves, settling reproduce tasks by verdict, escalating work wedged
in a gate, and reclaiming pushed commits that would otherwise be orphaned.

One rule governs all of it: **Forge only ever claims a branch the task actually
produced.** A discovered branch is adopted only if its head commit is newer than
the task's dispatch. Without that constraint, "find the branch the agent pushed"
degrades into "find any branch," which is how a task ends up attached to work it
never did.

---

## Backends

Forge does not run agents. It drives them through a narrow adapter interface:

```ts
interface BackendAdapter {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
  listEvents(input: ListEventsInput): Promise<ListEventsResult>;
  getSession(sessionId: string): Promise<GetSessionResult>;
  cancelSession(sessionId: string): Promise<void>;
  confirmToolUse(...): Promise<void>;
}
```

Six methods. Three implementations today: Claude Managed Agents, a
gateway backend, and Gemini. Each normalises its own event vocabulary into
Forge's, so the pipeline above is written once and works regardless of which
engine produced the events.

Forge is the puller, not the push target. It polls sessions rather than
receiving webhooks from them, which means a backend that goes away mid-session
is a state Forge discovers and handles, not an event it misses.

The adapter boundary is also where model choice lives. The agent — its model,
system prompt, tools and skills — is configured on the backend; Forge references
it by id. Changing the model behind a fleet is a configuration change, not a
deployment.

---

## The ledger

Auditability is the reason Forge exists rather than a feature it has.

Every meaningful event is appended to a single table, normalised across backends:

```
mission.started        planner.emitted       dispatcher.dispatched
agent.tool_use         agent.tool_result     agent.message
span.model_request_end span.network_request  session.status_idle
gate.pr_opened         ci.passed             ci.failed
ci.retry_dispatched    gate.escalated        gate.reclaimed
task.continued         task.halted           mission.completed
```

Two properties make this useful rather than merely voluminous.

**It is backend-agnostic.** A `agent.tool_use` from Managed Agents and one from
Gemini are the same shape. You can ask "what did this fleet do today" without
knowing which engine ran which task.

**It is the source of truth for decisions, not just a log of them.** The
continuation budget is counted from `task.continued` events. The CI retry gate
reads the SHA off the last `ci.retry_dispatched`. These are not denormalised
counters that can drift from the record — the record *is* the counter.

The ledger is exposed through the public API, because an audit trail reachable
only through a browser is not an audit trail.

---

## The API

Forge has a versioned `/api/v1` surface covering missions, tasks, the ledger and
repository policy. Authentication is a bearer token — accepted as
`Authorization: Bearer` or `x-api-key` — obtained through a device-authorization
flow, the same shape as `gh auth login`: request a code, approve it in the
browser, store the token.

Two properties are enforced across every endpoint. Ownership failures return
**404, not 403** — a resource's existence is not observable across accounts.
And every response goes through an explicit allow-list: fields are named to be
published, so a column added to the schema tomorrow is not automatically exposed
to every API consumer.

The OpenAPI document is generated from the same Zod schemas the handlers validate
with, and a test asserts that every path in it resolves to a route file that
exists and exports that method. A spec that describes routes which do not exist
is worse than no spec, because it will be trusted.

---

## What it looks like working

The clearest demonstration is Forge operating on its own repository.

An operator creates a mission through the API against a GitHub issue. The
dispatcher claims it and starts a sandboxed session with the repository cloned
and a git identity already configured. The agent reads the issue, writes the
change, commits, and pushes a branch. The reconciler opens the pull request. CI
runs. The task sits at `awaiting_ci` until the checks complete, then moves to
whichever gate the repository's policy specifies.

Start to pull request: about four and a half minutes.

The resulting change was a test pinning an assumption that a rate-limiting helper
mirrors from an upstream library, plus a comment documenting the coupling — the
work the issue asked for, in the two files it named.

---

## Current limits

Some things Forge does not do yet, and the shape of what is next.

**Scoped credentials.** The API token resolves to a user session. It is a real
identity with real ownership scoping, but it is not scoped to a subset of
operations. Per-scope tokens are a v2 concern.

**Organisations and roles.** Ownership is per-user. Team-owned policy needs a
model that does not exist yet.

**Observability.** The tick reports structured results and the ledger records
everything, but there is no OpenTelemetry instrumentation and no outbound
alerting on failure, stall or budget breach. For a system whose job is to run
unattended, that is the most valuable thing not yet built.

**Sandbox environment shaping.** An agent's sandbox has the network policy the
backend gives it. Making the environment fit the task — registry access for
builds, API access for tooling — is configuration an operator does today rather
than something Forge derives.

---

## The shape of the idea

If there is one thing worth taking from this design, it is the separation between
*an agent produced output* and *the output is done*. Those are different claims,
and most of the difficulty in running agent fleets comes from conflating them.

Forge's answer is that the second claim has to be earned: by CI, by an
independent review, by a policy the operator set, and by a record that survives
the session. The agent's own account of its work is an input to that decision,
never the decision itself.

Everything else — the tick, the adapters, the state machine — is machinery in
service of that one idea.
