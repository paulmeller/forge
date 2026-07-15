# Live Run View — Design

Date: 2026-07-16
Status: approved (brainstorm complete)
Routes touched: `/repos/[owner]/[repo]` (workspace pane), `/missions/[id]/tasks/[taskId]`
(task detail); new endpoints on both `apps/tick` and `apps/web`.

## Problem

The Repo Workspace's issue detail (`IssueTriageCard`) and the Task detail page
both show a Task's state as static, page-load-time snapshots — a headline
badge, stage rows, and (on the Task page) a JSON event Ledger. Compared
against a reference operator UI (a native app showing a live-scrolling
colored log and a per-run file browser), Forge's views read as "check back
later" rather than "watch it work."

Underlying mechanism (the actual reproduce → fix pipeline, real sandboxed
sessions, real verdicts) is confirmed working end-to-end as of this session.
This design closes the presentation gap.

## What's NOT achievable, and why

There is no real "list sandbox files" or "download workspace artifact" API
anywhere in the Managed Agents engine's OpenAPI spec (checked every
session-related route: `/v1/sessions/{id}` and its `resources`, `threads`,
`events`, `ui-messages` sub-resources — `resources` is write-only, for
*mounting inputs* like repos/files, never for reading back outputs). A
literal live view of the container filesystem is not possible through
Forge's current backend integration. The "file browser" in this design is
therefore a **synthesized presentation of data Forge already captures**
(prompt, event ledger, status/verdict) styled as file-like tabs — not a
window into the real sandbox.

## Decisions (settled with operator)

- File browser: synthesize from existing data (promptVars, event ledger,
  verdict/status) rather than skip it.
- Placement: **both** — Workspace pane gets a condensed live preview; the
  Task detail page gets the full view. Workspace links to Task detail for
  the complete picture.
- Stage selection: explicit **Reproduce / Fix tabs** (Forge's real two-stage
  model — not numbered attempts; Forge has no multi-version retry concept
  like the reference tool's "Bugfix v5/v6").
- Live mechanism: **true end-to-end streaming**, not polling — engine's real
  `/v1/sessions/{id}/events/stream` piped through to the browser, chosen
  over reusing the existing `LiveRefresh` polling component.

## Architecture: the streaming chain

**Constraint driving this:** `apps/tick` is invoked on a schedule (`POST
/tick`, Cloud Scheduler every 60s in prod) — it is not a long-lived process,
so it cannot hold persistent SSE connections as part of its normal batch
cycle without a different service shape. Also, only `apps/tick` holds
Managed Agents credentials today (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
`FORGE_MA_ENVIRONMENT_ID`) — `apps/web` never talks to the backend adapter
directly, and that boundary is preserved.

**Design:** a thin, on-demand proxy chain, entirely separate from the
scheduled tick loop:

1. **`apps/tick` gains `GET /tasks/:taskId/stream`.** Resolves the task's
   `sessionId` (existing `tasks.session_id` column, already populated by the
   dispatcher at session-create time), then opens the engine's
   `GET /v1/sessions/{sessionId}/events/stream` and pipes it through as SSE
   to the caller. This is a distinct code path from the cron-driven `/tick`
   handler — it only runs while something is connected, and touches none of
   tick's existing scheduled-batch architecture.
2. **`apps/web` gains `GET /api/repos/[owner]/[repo]/issues/[number]/stream`**
   (query param selects `reproduce` or `fix`). The browser connects here
   (same origin, no backend credentials ever reach the client). This route
   calls tick's new endpoint server-to-server — requires a new env var on
   `apps/web` (e.g. `TICK_INTERNAL_URL`, pointing at tick's own base URL;
   `http://localhost:8180` in local dev) since no such var exists today —
   and re-relays events to the browser via its own SSE response.
3. **Persisted Ledger is unchanged.** Final/settled events still land via
   the existing cron-scheduled `/tick` → poller → `ledgerEvents` path. The
   live stream is a purely additive, ephemeral UI layer — it never writes to
   the DB itself, and durability/audit behavior is untouched.

Chain: engine → tick (proxy) → web (proxy) → browser (`EventSource`). Each
hop is a thin pipe, not a transform; credentials stay exactly where they are
today (tick only).

**Lifecycle:** the browser only opens the `EventSource` connection when the
selected stage's task status is `running` (or `queued`/dispatching). Once a
task reaches a terminal status, no connection is opened — the log renders
from the already-ingested `ledgerEvents` rows instead. The proxy chain has
no independent lifecycle beyond the browser holding it open; closing the
tab/switching tabs closes the connection at every hop.

## Shared log rendering

One component renders a list of task-ledger events as human-readable,
monospace lines (timestamp + event type + a short rendered summary of the
payload — not raw JSON dumps). Both the condensed and full views use this
same component; they differ only in bounding (`max-height` + `overflow-y`
+ line-count truncation for condensed, unbounded for full) and in whether
they're fed a static list (terminal task, from `ledgerEvents`) or a live
`EventSource` stream (running task) that appends to the same rendering
list as events arrive.

## Workspace pane (condensed)

Replaces `IssueTriageCard`'s current flat stage-rows with:

- **Reproduce / Fix tabs.** Each tab's dot uses the existing `TriageHeadline`
  semantics (neutral/amber/green/red) — no new status vocabulary.
- Below the tabs: the shared log component, condensed — last ~15 lines,
  ~200px fixed height, auto-scrolling to bottom as lines arrive.
- **"View full run →"** link to `/missions/[id]/tasks/[taskId]` for the
  selected tab's stage.
- `WorkOnItButton` (Work on it / Work again / disabled-in-flight) stays
  below, unchanged from the existing Repo Workspace implementation.
- The verdict summary (reproduced/not-reproduced text, when present) renders
  above the log — it's the highest-signal single line once resolved.

## Task detail page (full)

`/missions/[id]/tasks/[taskId]` gains, above the existing Timeline/Ledger
cards:

- **Synthesized file tabs:**
  - `prompt.txt` — `task.promptVars`, pretty-printed.
  - `agent.log` — the full chronological event ledger rendered through the
    shared log component (human-readable lines, not raw JSON).
  - `console.log` — the same event set filtered to tool-call/tool-output
    events, **only if that distinction is actually present in event
    payloads**; if the backend doesn't carry a reliable tool-call vs.
    non-tool-call marker, this tab is dropped rather than faked with a
    guessed filter.
  - `status.json` — task status + verdict, pretty JSON (this one *is*
    literally JSON, unlike the other synthesized tabs, since that's what it
    actually is).
  - Tabs are visually/textually clear that this is Forge-captured data
    presented as files, not literal sandbox filesystem contents.
- **Full live log** below the tabs — the same shared component and the same
  SSE connection type as the Workspace pane's condensed view, unbounded
  height with scroll, connecting only while the task is running.
- **Existing Ledger card is unchanged**, staying below as the structured/
  audit view — the new `agent.log` tab is a human-readable rendering of the
  same underlying events, not a replacement for the raw JSON audit trail.

## Error handling

- SSE proxy failure at any hop (engine unreachable, tick down, task has no
  `sessionId` yet) → the affected view falls back to the static
  `ledgerEvents` rendering with no visible connection error to the operator
  — live is a nice-to-have, the static Ledger is always the source of truth
  and always renders regardless of streaming health.
- A task that finishes between the browser opening the connection and the
  first event arriving is a normal, race-free case: the connection simply
  yields no further events and the view is already showing the terminal
  state from its initial static load.

## Testing

- Unit: the shared log-rendering component's event→line formatting (pure,
  given a list of ledger-event-shaped objects); the `console.log` tab's
  inclusion/exclusion logic (present vs. absent based on payload shape).
- Integration: tick's `/tasks/:taskId/stream` resolves `sessionId` correctly
  and 404s cleanly for a task with none yet.
- Manual: watch a real reproduce task run start-to-finish in both the
  Workspace condensed view and the Task detail full view; confirm the log
  matches between both (same underlying stream/data); confirm graceful
  fallback to static Ledger when tick is stopped mid-connection.

## Out of scope

- Any literal sandbox filesystem browsing (confirmed not possible with the
  current backend integration).
- Numbered multi-attempt tabs (Forge's model stays two fixed stages).
- Changes to the cron-scheduled `/tick` reconciliation loop or its
  persistence path — this design adds a parallel, ephemeral read path only.
- Chat's separate, unrelated `ANTHROPIC_BASE_URL`/API-key gap (this engine
  has no `/v1/messages` route at all) — noted during this session, not
  addressed here.
