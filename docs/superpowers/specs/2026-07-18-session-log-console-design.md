# Session Log Console — Design

**Status:** Approved (2026-07-18).

## Scope

`SessionLogView` (`apps/web/src/components/session-log-view.tsx`) is the exhaustive, unfiltered feed of every event for one task — thinking, tool calls, session status ticks, all of it, no grouping or hiding. This is deliberately distinct from `Timeline`/`RoleTaggedEvent` (`components/timeline.tsx`, `components/role-tagged-event.tsx`), which is a separate, curated concept (grouped by task, collapsible, hides granular LLM noise by default) — Timeline's behavior is untouched by this work. The only thing shared between them is a tiny pure time-formatting helper (both already have near-identical private `HH:MM:SSZ` formatters); extracting it is a DRY refactor, not a merge of concepts.

`SessionLogView` has exactly two consumers today: the repo console's `IssueRunPanel` (Run Output panel) and the mission task-detail page. Both get this design automatically since they share the one component.

## Design

**1. Colorized per-line tags.** `formatLogLine()` (`lib/session-log-format.ts`) already returns strings like `[assistant] ...`, `[tool] ...`, `[session] running`, `[forge] ...` — untouched, still returns a plain string, its existing test suite is unaffected. `SessionLogView` splits each rendered line into `{tag, rest}` via `/^(\[[^\]]+\])(.*)$/s` and colors `tag` by `roleOf(event.eventType)` (already exported from `lib/event-roles.ts`, already used by Timeline — same palette, so the two views speak one visual language without being the same component): `forge` → `text-foreground`, `session` → `text-live`, `agent` → `text-warning`, `model` → `text-muted-foreground`. A new `isErrorLogEvent()` predicate overrides the tag to `text-destructive` regardless of role for `session.error` and any `agent.tool_result` that failed (`is_error === true` or a non-zero numeric `exitCode`) — severity always wins visually over role.

**2. Per-line mono timestamp.** Each line is prefixed with `formatConsoleTime(event.createdAt)` — the same terse UTC `HH:MM:SSZ` format Timeline already uses, extracted from `role-tagged-event.tsx`'s private `formatTime` into a shared `lib/format.ts` export (byte-identical output; `role-tagged-event.tsx` switches to import it — zero behavior change, pure dedup).

**3. Blinking live cursor.** When `isLive`, a `▍` block character renders after the last line, in `text-live`, with a CSS blink animation (new `.console-cursor` utility in `globals.css`, nested inside the existing `@media (prefers-reduced-motion: no-preference)` block alongside `.rise`/`.console-line-in` — renders solid, non-blinking under reduced motion).

**4. Smart auto-scroll (the "with updates" fix).** Today the view force-scrolls to bottom on every new event, yanking the user back down if they've scrolled up to read something. New behavior: track whether the user is "pinned" to the bottom (within ~24px) via a scroll listener; only auto-scroll when pinned. When not pinned and new events arrive, show a small floating "↓ N new" pill (bottom-right of the scroll container) that jumps to bottom and re-pins on click; the counter resets to 0 once pinned again.

## Non-Goals

- No change to `formatLogLine`'s return type or its existing test assertions.
- No change to `Timeline`/`RoleTaggedEvent` grouping, collapsing, or expand-by-default behavior.
- No new dependencies.

## Acceptance

- `pnpm typecheck` clean (all projects); new pure functions (`isErrorLogEvent`, `formatConsoleTime`) unit-tested; existing `session-log-format.test.ts` and `event-roles.test.ts` suites pass unchanged.
- Browser-verified in both consumers (repo console Run Output, task detail), dark and light: tag colors match role, an injected error line renders destructive-red regardless of role, timestamps render, cursor blinks only while live and respects reduced-motion, scrolling up during live updates stops auto-follow and shows the "↓ N new" pill, clicking it returns to bottom and resumes auto-follow.
