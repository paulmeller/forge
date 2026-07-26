# Backend Session Ref Persistence — Design

## Motivation

`GeminiManagedAgentsAdapter` tracks the live physical Gemini interaction id in a private in-memory map (`latestInteractionId`, `gemini-managed-agents.ts:57`). Gemini's Interactions API has no persistent multi-turn session id — every interaction, including follow-ups chained via `previous_interaction_id`, gets a brand-new id. Forge's `task.sessionId` is written once by the dispatcher (`dispatcher.ts:310`) and never updated, so the adapter needs its own logical→physical mapping.

That map is in-memory only. Nothing persists the physical id: `packages/db/src/schema.ts:175` stores only `sessionId`. Every adapter method resolves via `this.latestInteractionId.get(sessionId) ?? sessionId` (`gemini-managed-agents.ts:102, 113, 190, 203`), so an empty map silently falls back to the *original* interaction id from `createSession`.

The map goes empty in production. `getAdapter()` caches adapter instances in a module-level Map (`adapters/index.ts:15`), and the tick engine runs as a Next.js route on Cloud Run driven by Cloud Scheduler every 60s with `--min-instances=0` (`.github/workflows/deploy.yml`). Adapter state is therefore warm-instance-scoped and non-deterministic: it survives many ticks while an instance stays warm, vanishes on cold start, and is not shared when Cloud Run scales out.

Consequences:

1. **`cancelSession` silently fails to stop a running agent.** It POSTs `/cancel` to an already-finished interaction instead of the live one. Used by the budget hard stop (`budgets.ts:214`) and guardrails (`guardrails.ts:139`) — a runaway agent a budget cap is supposed to kill may keep running.
2. **`sendTurn` loses context.** It chains `previous_interaction_id` from turn 1 rather than the latest turn.

The original design doc (`2026-07-22-gemini-backend-adapter-design.md:93`) acknowledged that in-memory *usage* tracking resets on restart, but never considered that the interaction id has the same lifetime problem with far worse consequences.

## Scope

- Persist the live backend session ref so it survives cold start and scale-out.
- Thread it through the adapter interface in both directions (read and write).
- Harden the two `cancelSession` call sites so a failed cancel is visible rather than silent.

**Gemini-only by nature, general by interface.** Verified directly: `managed-agents.ts` and `gateway.ts` hold zero in-memory per-session state — neither has a `Map`/`Set` field. Gemini is the only backend whose physical handle rotates. The interface change below is written generally so a future rotating backend needs no further plumbing, but only the Gemini adapter implements non-trivial behavior for it.

## Out of Scope

- The `terminalEmitted` / `processedStepCount` / `lastSeenUsage` multi-turn staleness finding. Investigated and dismissed: all three `sendTurn` call sites leave the task in `awaiting_ci`, which is not in `POLLABLE_STATUSES` (`poller.ts:28`), so `listEvents` is never called again for those tasks and the stale caches are unreachable. The lost second-turn observability is backend-agnostic and by design (`ci.ts:133-134`).
- Resetting `eventLog`. It must **not** be reset — the poller's cursor is a ledger-derived id that has to remain findable in the log (`poller.ts:83-93`, `gemini-managed-agents.ts:181`).

## Storage: a new column, not an overwrite

Add a nullable `backendSessionRef` (`backend_session_ref`) text column to `tasks`. Do **not** overwrite `sessionId` with the rotating id.

Overwriting `sessionId` would introduce a real bug. The Gemini adapter's synthetic event ids embed the sessionId (`${sessionId}:step:${i}`, `${sessionId}:status:completed`), and the poller's cursor is a ledger-derived id that must stay findable in the adapter's `eventLog` via `findIndex` (`gemini-managed-agents.ts:181`). Rotating `sessionId` mid-session would orphan any cursor issued before the rotation: `findIndex` returns `-1`, and the fallback replays the entire log. This is masked today only because post-`sendTurn` tasks sit in `awaiting_ci` and are never polled again — a latent failure resting on an unrelated invariant that could change.

Semantically the two values are also distinct: `sessionId` is Forge's stable logical handle for a task's backend work; the interaction id is a rotating backend implementation detail. Conflating them is the root cause of this entire class of problem.

`backendSessionRef` is nullable only to accommodate tasks created before the migration. Going forward the dispatcher always populates it (see Write points), including for non-rotating backends where it simply stays equal to `sessionId` for the task's lifetime. Always populating it keeps the read path uniform — no caller needs to branch on backend kind.

## Interface: thread the ref both directions

Persisting alone is insufficient — a cold instance must also *read* the persisted ref. The in-memory map is demoted from source of truth to a pure cache.

```ts
export type SendTurnInput = {
  sessionId: string;
  text: string;
  /** Live backend handle from a prior turn, when the backend rotates it. */
  backendSessionRef?: string | null;
};

export type SendTurnResult = {
  /** Present only when this turn produced a new backend handle to persist. */
  backendSessionRef?: string;
};

export interface BackendAdapter {
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
  cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void>;
  getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>;
  listEvents(input: ListEventsInput): Promise<ListEventsResult>; // input gains backendSessionRef?: string | null
}
```

`sendTurn` takes an object rather than a third positional parameter, matching the existing `listEvents(input)` precedent in the same interface.

Adapters stay pure HTTP clients with no DB access. `managed-agents` and `gateway` ignore `backendSessionRef` entirely and return `{}` from `sendTurn`. The Gemini adapter resolves its physical id as: passed-in `backendSessionRef` → in-memory cache → `sessionId` fallback (unchanged as a last resort, for pre-migration tasks).

## Write points

- **Initial:** `dispatcher.ts:310` sets `backendSessionRef: sessionId` in the same `db.update` that already sets `sessionId`. This is unconditional — for Gemini it is the first interaction id, for other backends it is a stable duplicate of `sessionId`. `createSession` therefore needs no signature change.
- **Rotation:** the three `sendTurn` call sites persist a returned `backendSessionRef` when present.

The three rotation sites do **not** share one shape, and the plan must treat them individually:

- `ci.ts:201` — `sendTurn` is followed by an inline `db.update` on the task (`ci.ts:206-215`). The ref folds directly into that existing write.
- `verify.ts:241` and `ai-review.ts:215` — the subsequent DB write happens inside helper functions (`retry(...)` and `rejectAndRetryTask(...)` respectively), not inline. The ref must be threaded into those helpers, or written by a separate targeted update before they are called.

At all three sites `sendTurn` is wrapped in a `try`/`catch` that logs and continues, so the returned ref must be captured inside the `try` block; a thrown `sendTurn` leaves the stored ref unchanged, which is correct (no new interaction was created).

## Cancel hardening

The existing error handling is not the problem. Both call sites already `try`/`catch` and log a warning (`budgets.ts:214-220`, `guardrails.ts:139-145`). The failure is invisible because cancelling an already-finished interaction returns HTTP 200 — a *successful* call to the wrong target, with no exception to catch.

Hardening is therefore verification, not restructuring. After `cancelSession` returns, call `getSession` and confirm the status actually reached `terminated`. If it did not:

- Log at **error** level (currently `warn`, and only on a thrown error).
- Write a ledger event (`budgets.hard_stop_cancel_unverified` / `guardrails.cancel_unverified`) so "did the budget cap actually stop this agent?" is auditable in the run output UI.

This preserves the deliberate best-effort contract — `guardrails.ts:136` states a cancel failure must not block the status change, and it still doesn't. The task is still marked `failed` exactly as before; only the visibility of a silent failure changes.

This also gives `adapter.getSession` its first production caller; it is currently dead code (no non-test call sites).

## Migration

Generate via drizzle-kit rather than hand-writing the SQL.

Earlier work in this repo found `0004_auth_tables.sql` present on disk but never registered in `meta/_journal.json` — drizzle's migrator only runs journal-listed files, so it had never executed in *any* environment including production, and the file also lacked `--> statement-breakpoint` markers (so only its first statement would have run even once registered). Any hand-written migration must explicitly add its journal entry and breakpoint markers. Using drizzle-kit avoids both failure modes.

Adding a nullable column requires no backfill.

## Testing

- **Adapter unit tests** (`gemini-managed-agents.test.ts`, existing `vi.stubGlobal('fetch')` pattern): a passed-in `backendSessionRef` is preferred over the in-memory cache; preferred over the `sessionId` fallback when the cache is empty (the cold-start case this fix exists for); `sendTurn` returns the rotated ref.
- **Non-rotating adapters:** `managed-agents`/`gateway` return `{}` from `sendTurn` and behave identically whether or not a ref is passed.
- **Persistence integration test** (real throwaway libSQL + drizzle migration, the convention used by `setup/actions.test.ts` and `repo-activity.test.ts`): after a `sendTurn` that rotates the ref, `tasks.backendSessionRef` holds the new value.
- **Cancel hardening:** a cancel that leaves the session non-terminated produces the error log and the ledger event, and does not prevent the task's status change to `failed`.
