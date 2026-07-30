# Factory economics — making agent runs cheap enough to parallelise

**Date:** 2026-07-31
**Status:** Approved (plan agreed in session; phases execute independently)
**Related:** #58, #14, #15, #16, #69, #70, #68; PRD §3.1, §9

## Problem

The autonomous loop is now **correct** — dispatch → commit → push to the
Forge-named branch → PR → gates, proven live three times — but not
**economical**. Measured on real dogfood runs against this repo:

| Run | Tokens | Tool calls | Diff | Outcome |
|---|---|---|---|---|
| #42 | 8.6M | ~100 | +199/−28 | correct, recovered by hand |
| #67 | 14.5M | ~115 | +488/−5 | correct, recovered by hand |
| #41 | 12.0M | 147 | +1842/−84 | correct, PR #71 opened |

The same model in an interactive session fixes comparable issues at a small
fraction of that. The gap is not intelligence — the #67 and #42 diffs were
merged-quality — it is **operating conditions**. A software factory's unit
economic is cost per merged change; at ~12M tokens per small fix, parallelism
cannot pay for itself.

**Target:** a #41-class fix at **<2M tokens, <60 tool calls, diff proportional
to the ask**. Floor: ~3–5× an interactive session — autonomy has a real price;
the factory wins on parallelism, not per-unit heroics.

## Root causes (measured, in cost order)

1. **Amputated feedback loop (#58).** The sandbox has no package registry, so
   the agent cannot run typecheck/lint/tests. This distorts behaviour, not just
   verification: it over-reads to simulate confidence and over-writes to be
   "safe". Both merged agent PRs shipped typecheck errors the agent had no way
   to catch.
2. **Monolithic sessions pay superlinear token cost.** 147 tool calls in one
   turn means every file read stays in context and every later call re-pays for
   all earlier reads. The 12M figure is not 100× the work — it is the same work
   carried in an ever-heavier context.
3. **Cold-start tax.** ~30–50 tool calls per task re-deriving repo layout,
   commands, conventions. Fixed overhead; dominates small tasks.
4. **Open-loop control.** One prompt, then millions of tokens uncorrected.
   Scope drifts (+1842 lines for a webhook dedup); one sentence of steering
   would have prevented it.
5. **Wrong decomposition.** A reproduce phase for issues with nothing to
   reproduce (#70) spends a full session on a task that cannot succeed.

## Phases

Each phase attacks one cause, is independently shippable, and is measured by
re-running a #41-class fix and publishing the delta.

### Phase 0 — Instrument (Forge, ~½ day)

The ledger already records `costTokens`, tool events and diff stats; nothing
surfaces them. Add a per-task/per-mission **cost report** — tokens, tool calls,
diff size, outcome — on the mission page and in the tick summary, and track
**tokens-per-merged-task** as the factory metric (twin of PRD §9's human-touches
metric). *Acceptance:* "what did that fix cost?" is answerable without SQL.

### Phase 1 — Restore the inner loop (managed-agents + config, 1–2 days)

Provision-time setup: after clone, run a per-repo **setup command**
(e.g. `pnpm install`) **with registry egress, before the agent takes over**;
egress then tightens to `github.com` for the agent's entire session. The agent
never gets registry access — the provisioner does, briefly, under operator
control. Same seam as the git-identity fix (`provision-common.ts`). Later
variant: pre-baked per-repo images with warm `node_modules`.
*Acceptance:* a dispatched agent runs `pnpm typecheck && pnpm -r test`
successfully; the next agent PR has zero typecheck errors.
*Decision required:* operator sign-off on provision-time egress (posture
change, though never agent-facing).

### Phase 2 — Scope discipline (agent record + skills, ~½ day)

Add to the agent system prompt and fix skills:
- "Make the smallest change that fixes the issue. No drive-by refactors, no
  speculative hardening. If your diff exceeds ~200 lines, stop, commit what you
  have, and explain why more is needed."
- "Read only what the task requires — do not survey the codebase."

Enforceable now: #67's dispatch-time contract check means these instructions
cannot silently drift. *Acceptance:* next comparable fix lands <300 lines.

### Phase 3 — Kill the cold-start tax (Forge #14/#15/#16, 2–3 days)

The MA harness already supports memory mounts (`memory: true`). Per repo:
create/mount a Memory Store (#14); on merge, a retrospective writes layout,
commands and gotchas to it (#16); stable learnings promote into AGENTS.md via
human-reviewed PR (#15 — the PRD's auto-learning drift risk applies verbatim).
*Acceptance:* the second task on a repo spends measurably fewer orientation
calls than the first. This is also the moat cluster: the factory gets cheaper
with use.

### Phase 4 — Close the loop mid-run (Forge #69, 2–3 days)

First-commit checkpoint: pause, surface intended scope in the run view, steer
or auto-continue. Interaction with the no-progress guard (#57) must be
designed, not patched. Risk-proportional auto-continue arrives with #68.

### Phase 5 — Right-size the work (Forge #70 remainder, ~1 day)

Default to a single `fix` task; emit a reproduce phase only when the issue is
identifiably a bug (labels first, heuristics later).

## Deferred

#68 (risk-proportional gates) and a productised plan gate optimise quality
routing, not cost. Re-run the economics after Phase 3 before building them.

## Measurement protocol

After each phase: dispatch one comparable small fix, record tokens / tool calls
/ diff / outcome in the cost report, append the row to this spec. No phase is
"done" on implementation alone — only on a measured delta.
