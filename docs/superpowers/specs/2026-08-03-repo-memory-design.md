# Repo Memory — Design

**Status:** approved-pending-review · **Supersedes:** issues #14, #15, #16 (written pre-restructure; most of what they specify now exists in some form)
**Date:** 2026-08-03

## Problem

Every task pays the cold-start tax: the agent re-explores the repo, rediscovers
conventions, and repeats mistakes earlier sessions already paid for. Forge has
a complete curated-memory design in the codebase — but three links are
unwired, so none of it runs:

| Piece | State |
|---|---|
| `memories` table (scope, confidence 0–100, expiry, provenance) | built, queried at dispatch |
| Memory injection into task prompt (`dispatcher.ts` → `formatMemoriesForPrompt`) | **wired, works** |
| Expiry sweep (tick `memory` stage) | **wired, works** |
| `retrospectives` + `retrospective_proposals` tables, review UI, `POST /api/missions/:id/retrospect` | built |
| Retrospective *execution* — `createRetrospective` builds an analysis prompt and returns it; nothing ever dispatches it | **unwired: rows stall at `pending`** |
| Accepted proposal → memory row — `createMemoryFromProposal` | **zero callers** |
| Confidence movement — `boostConfidence` / `decayConfidence` | **zero callers** |
| Auto-trigger on mission completion | absent |
| MA memory-store mounting | absent |

So the shortest path to working repo memory is not new machinery — it is
closing three gaps in machinery that already shipped, then adding the MA
store as the delivery layer.

## Engine facts this design relies on (verified in managed-agents source)

- A memory store is a versioned filesystem: memories are `path` + `content`
  (engine limits: 100 KB/memory, 2000/store). Sessions attach stores via
  `resources: [{type:'memory_store', memory_store_id, access, instructions}]`;
  files appear at `/mnt/memory/<slug>/` for the claude-code harness
  (dialect `memoryRoot:'shared'`).
- `access:'read_only'` is enforced per mount at the capture seam:
  `session-runtime.ts` `postTurn()` skips non-`read_write` mounts, so
  in-sandbox writes to a read-only mount are never persisted. (They are not
  fs-blocked inside the container — "read-only" means *never captured*, which
  is the property we need.)
- Every non-no-op mutation appends an immutable `memory_version`. Accountability
  is versioning, not prevention: upstream CMA has no write gate.
- Store list has no name filter (parity with upstream) — clients must persist
  store ids, not look them up by name.

## Design decisions

**D1 — Two stores per repo, two trust levels (both CMA-native).**
- `forge-curated-<owner>-<repo>` — mounted `read_only` on every task session.
  Forge is the only writer; content is exclusively human-accepted retrospective
  proposals. Knowledge that outlives a mission passed a gate.
- `forge-scratch-<owner>-<repo>` — mounted `read_write`. The agent's own
  working notes, ordinary CMA usage, full version history. Bounded blast
  radius: nothing in scratch is authoritative until promoted.
Rationale: memory is an instruction channel (the #66 lesson). An ungated
shared read-write store would let one session instruct all future sessions.
But an all-read-only design fights the platform and forfeits cheap
within-repo carryover. Staging vs production, for knowledge.

**D2 — One brain: DB governs, store delivers.**
The Forge `memories` table remains the source of truth for *governance*
(confidence, provenance, expiry, evidence links — none of which CMA models).
The curated store is a *sync target* holding the content. No second
authority; sync is one-directional (DB → store) and idempotent. Long term
this inherits any retrieval/compaction features the platform adds.

**D3 — Prompt injection stays, becomes a header, not the corpus.**
Today's `formatMemoriesForPrompt` injects every relevant memory. With the
store mounted, the prompt carries the top **10** by confidence, plus one
line pointing at `/mnt/memory/forge-curated-…/` for the rest. Large corpora
become read-on-demand instead of paid-per-prompt.

**D4 — Governance data never enters a store.** Budgets, spend, gate state
stay in the ledger. An agent that can read its own budget can reason about
its governor.

**D5 — #15 (AGENTS.md upkeep) shrinks to a prompt instruction.** The task
prompt gains: "If you created files at paths AGENTS.md does not mention,
add them to AGENTS.md in the same branch." Rides the PR, reviewed like any
diff, no extra turn, no reconciler analysis pass. The heuristics in #15
(exploration-ratio analysis) fold into the retrospective instead.

## Slices

### Slice A — close the retrospective loop (supersedes #16)

1. **Dispatch the retrospective.** `createRetrospective` already builds the
   analysis prompt. New: `runRetrospectives(log)` tick stage (after
   reconciler, before memory expiry) claims `pending` retrospectives (CAS
   `pending→running`), creates a **repo-less MA session** via the existing
   backend adapter (no `github_repository` resource, no clone token; ledger
   excerpts embedded in the prompt; same agent record as task sessions —
   a model override is a later optimization, not part of this slice), and
   stores `sessionId` on the row.
2. **Harvest.** The poller-equivalent within the same stage: when the
   retro session idles, parse the final agent message as JSON
   (`{proposals: [{type, content, evidenceEventIds}]}` — strict Zod, parse
   failure ⇒ retrospective `failed` with the error stored in `analysis`,
   never a crash). Insert `retrospective_proposals` rows; retrospective →
   `completed`.
3. **Wire acceptance.** `reviewProposal(…, 'accepted'|'edited')` calls
   `createMemoryFromProposal` (the existing zero-caller function) for
   `memory_entry` proposals. `skill_diff` proposals stay manual-apply (out
   of scope here).
4. **Auto-trigger.** Reconciler, on mission → `completed`: insert a
   `pending` retrospective iff none exists for the mission and the mission
   recorded > 0 tool calls. Ledger event `retrospective.requested`
   (idempotence via the existing one-per-mission check in
   `createRetrospective` — invariant: one send per cycle, counted by
   ledger/DB state, never per tick).
5. **Evidence link.** Dispatcher records ledger event `memory.injected`
   `{taskId, memoryIds}` whenever memories go into a prompt. Prerequisite
   for Slice B.

### Slice B — confidence feedback

Pure function `decideConfidenceDeltas(events, taskOutcome)`:
- task settled `merged` → `boostConfidence(injectedIds, +5)`
- task settled `failed`/`abandoned`, or `needs_human` with
  `escalation_reason='ai_review_rejected'` → `decayConfidence(injectedIds, −10)`
- other settlements (external merge, resolved) → no change.
Called from the reconciler at settlement, reading `memory.injected` events
for the task. Ledger event `memory.confidence_adjusted` `{memoryId, delta,
taskId}` per adjustment. Memories crossing the existing expiry/confidence
floor are handled by the already-wired expiry sweep.

### Slice C — MA stores as delivery (corrected #14)

1. **Schema:** new table `repo_memory_stores(repo primary key,
   curated_store_id, scratch_store_id, created_at)` — ids persisted because
   the store API has no name lookup.
2. **`ensureRepoMemoryStores(repo)`** (new lib): create both stores via the
   engine API on first dispatch for a repo; upsert the row. Engine
   unreachable ⇒ dispatch proceeds **without** mounts this tick (memory is
   an amplifier, not a gate — never block work on it) and retries next tick.
3. **Adapter:** `CreateSessionInput` gains
   `memoryMounts?: Array<{storeId: string; access: 'read_only'|'read_write'}>`;
   the managed-agents adapter maps them to `resources[]` entries. Adapters
   that don't support stores ignore the field (documented, per the
   capability-honesty convention).
4. **Dispatcher:** mount curated read-only + scratch read-write on every
   task session; prompt note (D3) points at the curated path.
5. **Sync:** after any accepted proposal lands a memory row (Slice A step 3)
   and on memory expiry, sync the delta to the curated store:
   path `curated/<scope>/<key>.md`, content = value + provenance footer.
   Idempotent upsert; deletion on expiry. One-directional, DB is truth (D2).
6. **Promotion path:** retrospective prompt (Slice A) receives the mission's
   scratch-store *version history* summary as evidence input — scratch
   writes become proposal candidates; acceptance promotes to curated.

## Ordering and dependency

A is standalone and highest value (it activates everything already built).
B depends on A5 only. C depends on nothing but is worth doing after A so
promoted content exists to sync. Recommended: A → B → C, three plans.

## Testing

- Every new decision function is pure and unit-tested (parse-harvest,
  decideConfidenceDeltas, sync-delta computation, ensure-stores state
  machine), mutation-tested per skills/bug-fix step 5.
- Slice A end-to-end: fixture mission → completed → retrospective session
  dispatched (adapter mocked) → harvest fixture JSON → proposals inserted →
  accept → memory row exists → next dispatch injects it (existing test
  seam in dispatcher.test.ts).
- Slice C: adapter mapping test (memoryMounts → resources[]); read-only
  enforcement is engine-tested (not re-tested here), but one integration
  test pins that curated is requested `read_only` — a regression to
  read_write is a security fault, test named accordingly.

## Issue disposition

- #14 → superseded by Slice C (two stores, not one; read-only curated; ids
  persisted, not name-looked-up).
- #15 → superseded by D5 (prompt instruction) + retrospective heuristics.
- #16 → superseded by Slice A (dispatch the built prompt; proposals +
  review gate instead of unreviewed direct writes; sync handles the store).
Close all three linking here when the first plan lands.

## Open questions for the MA team (blocking none of Slice A/B)

1. **Upstream limits parity:** issue #14 claimed 30-day version retention
   and 8 stores/session. Neither exists in the engine (engine has
   100 KB/memory, 2000 memories/store). Confirm upstream numbers and
   whether the engine should enforce them for parity — affects how much
   history the scratch store can carry.
2. **Version-history listing cost:** Slice C6 wants "what changed in
   scratch this mission" — `GET /v1/memory_stores/:sid/memory_versions`
   filtered by time covers it; confirm the engine's filter set matches
   upstream (`agent-memory-2026-07-22` semantics are implemented; just
   confirm version-list filtering by created_at is included).
3. **FYI, no action:** Forge will create two stores per active repo and
   mount both on every task session — if a per-session mount count limit
   ever lands (see Q1), Forge consumes 2 of it.
