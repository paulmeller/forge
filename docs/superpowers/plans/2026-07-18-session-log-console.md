# Session Log Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `SessionLogView` — the exhaustive per-event feed used by the repo console's Run Output panel and the task-detail page — read and behave like a real IDE log-tail console, per `docs/superpowers/specs/2026-07-18-session-log-console-design.md`.

**Architecture:** Two new pure helpers (`isErrorLogEvent` in `lib/session-log-format.ts`, `formatConsoleTime` in `lib/format.ts`, the latter also replacing a duplicated private formatter in `role-tagged-event.tsx`), then a `SessionLogView` rewrite: a non-scrolling `relative` wrapper (owns sizing/border, unchanged caller `className` semantics) containing an absolutely-positioned (`inset-0`) scrolling inner pane (owns the actual scroll + content), so a "jump to bottom" pill can float over it without scrolling away. `Timeline`/`RoleTaggedEvent`'s own grouping/collapsing behavior is untouched.

**Tech Stack:** Next.js App Router (Client Component), Tailwind v4, vitest (node env, pure-function tests only).

## Global Constraints

- Every commit leaves the whole monorepo `pnpm typecheck` clean (all 4 projects `Done`).
- Do NOT run `pnpm lint` (pre-existing repo-wide breakage — out of scope).
- `formatLogLine`'s return type and its existing test assertions in `session-log-format.test.ts` are NOT to change — only additive tests.
- No changes to `Timeline`, `RoleTaggedEvent`'s grouping/collapse/expand-by-default logic — only its private `formatTime` is replaced by the shared helper (byte-identical output).
- No new dependencies.
- Line numbers below were captured at plan-writing time and may drift a few lines — match on the quoted old strings, which are unique per file.

---

### Task 1: Shared helpers — `isErrorLogEvent`, `formatConsoleTime`

**Files:**
- Modify: `apps/web/src/lib/session-log-format.ts`
- Modify: `apps/web/src/lib/session-log-format.test.ts`
- Modify: `apps/web/src/lib/format.ts`
- Modify: `apps/web/src/lib/format.test.ts`
- Modify: `apps/web/src/components/role-tagged-event.tsx`

**Interfaces:**
- Produces: `isErrorLogEvent(event: LogEventLike): boolean` (from `lib/session-log-format.ts`), `formatConsoleTime(date: Date): string` (from `lib/format.ts`) — both consumed by Task 2.

- [ ] **Step 1: Write the failing tests for `isErrorLogEvent`** — append to `apps/web/src/lib/session-log-format.test.ts`, after the existing `describe('isToolEvent', ...)` block and its import line updated:

Change the import at the top of the file from:

```ts
import { formatLogLine, isToolEvent, normalizeRawSessionEvent } from './session-log-format';
```

to:

```ts
import {
  formatLogLine,
  isErrorLogEvent,
  isToolEvent,
  normalizeRawSessionEvent,
} from './session-log-format';
```

Then append this new `describe` block after the `describe('isToolEvent', ...)` block (before `describe('normalizeRawSessionEvent', ...)`):

```ts
describe('isErrorLogEvent', () => {
  it('is true for session.error', () => {
    expect(isErrorLogEvent({ eventType: 'session.error', payload: {} })).toBe(true);
  });

  it('is true for a failed tool_result via is_error', () => {
    expect(
      isErrorLogEvent({ eventType: 'agent.tool_result', payload: { is_error: true, content: {} } }),
    ).toBe(true);
  });

  it('is true for a failed tool_result via a non-zero exit code', () => {
    expect(
      isErrorLogEvent({
        eventType: 'agent.tool_result',
        payload: { is_error: false, content: { exitCode: 1 } },
      }),
    ).toBe(true);
  });

  it('is false for a successful tool_result', () => {
    expect(
      isErrorLogEvent({
        eventType: 'agent.tool_result',
        payload: { is_error: false, content: { exitCode: 0 } },
      }),
    ).toBe(false);
  });

  it('is false for unrelated event types', () => {
    expect(isErrorLogEvent({ eventType: 'agent.message', payload: {} })).toBe(false);
    expect(isErrorLogEvent({ eventType: 'session.status_running', payload: {} })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- session-log-format`
Expected: FAIL (`isErrorLogEvent` is not exported).

- [ ] **Step 3: Implement `isErrorLogEvent`** — in `apps/web/src/lib/session-log-format.ts`, add this new exported function immediately after the existing `formatLogLine` function (before `export function isToolEvent`):

```ts
export function isErrorLogEvent(event: LogEventLike): boolean {
  if (event.eventType === 'session.error') return true;
  if (event.eventType !== 'agent.tool_result') return false;
  const p = asRecord(event.payload);
  if (p.is_error === true) return true;
  const content = asRecord(p.content);
  return typeof content.exitCode === 'number' && content.exitCode !== 0;
}
```

(`asRecord` is already a private helper in this file — reuse it, don't redefine it.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter web test -- session-log-format`
Expected: all tests pass, including the existing ones (unchanged).

- [ ] **Step 5: Write the failing test for `formatConsoleTime`** — append to `apps/web/src/lib/format.test.ts`. Change the import line from:

```ts
import { formatDateTime, formatRelative, formatTokens, formatUsd } from './format';
```

to:

```ts
import { formatConsoleTime, formatDateTime, formatRelative, formatTokens, formatUsd } from './format';
```

Then append this new `describe` block at the end of the file (after `describe('formatTokens', ...)`):

```ts
describe('formatConsoleTime', () => {
  it('formats as deterministic UTC HH:MM:SSZ regardless of local timezone', () => {
    expect(formatConsoleTime(new Date('2026-07-17T21:07:19.000Z'))).toBe('21:07:19Z');
  });

  it('zero-pads single-digit components', () => {
    expect(formatConsoleTime(new Date('2026-01-01T03:04:05.000Z'))).toBe('03:04:05Z');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter web test -- format.test`
Expected: FAIL (`formatConsoleTime` is not exported).

- [ ] **Step 7: Implement `formatConsoleTime`** — in `apps/web/src/lib/format.ts`, add this new exported function at the end of the file:

```ts

/** "21:07:19Z" — deterministic UTC time for dense console/log-tail displays,
 *  where locale-aware formatting would risk a server/client hydration
 *  mismatch (the same reasoning as formatDateTime's fixed 'en-US' locale,
 *  but console voice is UTC HH:MM:SS, not a localized clock). */
export function formatConsoleTime(date: Date): string {
  return date.toISOString().slice(11, 19) + 'Z';
}
```

- [ ] **Step 8: Run the tests, verify they pass**

Run: `pnpm --filter web test -- format.test`
Expected: all tests pass, including the existing ones (unchanged).

- [ ] **Step 9: Dedupe `role-tagged-event.tsx`'s private formatter onto the shared one.**

Replace this block:

```tsx
import { cn } from '@/lib/utils';
import {
  extractPrUrl,
  roleOf,
  shortLabel,
  shouldExpandByDefault,
  type EventRole,
} from '@/lib/event-roles';
import type { LedgerEvent } from '@forge/db';
```

with:

```tsx
import { formatConsoleTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  extractPrUrl,
  roleOf,
  shortLabel,
  shouldExpandByDefault,
  type EventRole,
} from '@/lib/event-roles';
import type { LedgerEvent } from '@forge/db';
```

Then delete this now-redundant private function entirely:

```tsx
function formatTime(date: Date): string {
  // UTC HH:MM:SS — deterministic across server and client. Locale-aware
  // formatting causes hydration mismatches when server (Node) and browser
  // pick different locales (e.g. en-US "AM" vs en-AU "am").
  return date.toISOString().slice(11, 19) + 'Z';
}
```

Then update its one call site from:

```tsx
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatTime(event.createdAt)}
        </span>
```

to:

```tsx
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatConsoleTime(event.createdAt)}
        </span>
```

(Output is byte-identical — this is a pure dedup, not a behavior change.)

- [ ] **Step 10: Typecheck + full web tests**

Run from repo root: `pnpm typecheck && pnpm --filter web test`
Expected: 4/4 `Done`; all test files pass (now 22 files: +1 for the format.test additions being in an existing file, +0 new files — session-log-format.test.ts and format.test.ts both already existed, so file count stays the same, test count increases by ~7).

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/lib/session-log-format.ts apps/web/src/lib/session-log-format.test.ts apps/web/src/lib/format.ts apps/web/src/lib/format.test.ts apps/web/src/components/role-tagged-event.tsx
git commit -m "feat(console): isErrorLogEvent + formatConsoleTime helpers; dedupe role-tagged-event's private time formatter"
```

---

### Task 2: SessionLogView rewrite — colorized tags, timestamps, live cursor, smart auto-scroll

**Files:**
- Modify: `apps/web/src/components/session-log-view.tsx` (full rewrite)
- Modify: `apps/web/src/app/globals.css` (append cursor keyframe/utility)

**Interfaces:**
- Consumes: `isErrorLogEvent`, `formatConsoleTime` (Task 1); `roleOf`, `type EventRole` (already exported from `@/lib/event-roles`, unchanged).
- `SessionLogView`'s public props (`taskId`, `isLive`, `initialEvents`, `maxLines`, `className`) are UNCHANGED — both consumers (`issue-run-panel.tsx`, `tasks/[taskId]/page.tsx`) need no edits.

- [ ] **Step 1: Rewrite `session-log-view.tsx`** — replace the entire file contents with:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

import type { EventRole } from '@/lib/event-roles';
import { roleOf } from '@/lib/event-roles';
import { formatConsoleTime } from '@/lib/format';
import {
  formatLogLine,
  isErrorLogEvent,
  normalizeRawSessionEvent,
  type LogEventLike,
} from '@/lib/session-log-format';
import { cn } from '@/lib/utils';

type LogEvent = LogEventLike & { id: string; createdAt: Date | string };

const ROLE_TAG_CLASS: Record<EventRole, string> = {
  forge: 'text-foreground',
  session: 'text-live',
  agent: 'text-warning',
  model: 'text-muted-foreground',
};

const LINE_RE = /^(\[[^\]]+\])(.*)$/s;

const PIN_THRESHOLD_PX = 24;

export function SessionLogView({
  taskId,
  isLive,
  initialEvents,
  maxLines,
  className,
}: {
  taskId: string;
  isLive: boolean;
  initialEvents: LogEvent[];
  maxLines?: number;
  className?: string;
}) {
  const [events, setEvents] = useState<LogEvent[]>(initialEvents);
  const [newCount, setNewCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prevLengthRef = useRef(initialEvents.length);

  useEffect(() => {
    setEvents(initialEvents);
    prevLengthRef.current = initialEvents.length;
    pinnedRef.current = true;
    setNewCount(0);
    // Only re-seed when the task changes — live events accumulate on top
    // independently, and initialEvents is a snapshot taken once per render
    // of the parent, not a dependency we want to re-trigger on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (!isLive) return;
    const source = new EventSource(`/api/tasks/${taskId}/stream`);
    source.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as unknown;
        const normalized = normalizeRawSessionEvent(parsed);
        setEvents((prev) => [...prev, normalized]);
      } catch {
        // Malformed frame (e.g. a keepalive comment surfaced as a message in
        // some browsers) — drop it rather than crash the view.
      }
    };
    return () => source.close();
  }, [taskId, isLive]);

  useEffect(() => {
    const el = containerRef.current;
    const delta = events.length - prevLengthRef.current;
    prevLengthRef.current = events.length;
    if (!el || delta <= 0) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setNewCount((n) => n + delta);
    }
  }, [events]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    pinnedRef.current = atBottom;
    if (atBottom) setNewCount(0);
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setNewCount(0);
  }

  const visible = typeof maxLines === 'number' ? events.slice(-maxLines) : events;

  return (
    <div className={cn('relative overflow-hidden rounded-md border bg-muted/40', className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="text-muted-foreground">No activity yet.</p>
        ) : (
          visible.map((event) => {
            const line = formatLogLine(event);
            const match = LINE_RE.exec(line);
            const tag = match ? match[1] : line;
            const rest = match ? match[2] : '';
            const tagClass = isErrorLogEvent(event)
              ? 'text-destructive'
              : ROLE_TAG_CLASS[roleOf(event.eventType)];
            return (
              <div key={event.id} className="console-line-in whitespace-pre-wrap break-words">
                <span className="mr-2 text-muted-foreground">
                  {formatConsoleTime(new Date(event.createdAt))}
                </span>
                <span className={tagClass}>{tag}</span>
                {rest}
              </div>
            );
          })
        )}
        {isLive ? (
          <span className="console-cursor text-live" aria-hidden>
            ▍
          </span>
        ) : null}
      </div>
      {newCount > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-2 right-2 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background shadow-sm hover:opacity-90"
        >
          ↓ {newCount} new
        </button>
      ) : null}
    </div>
  );
}
```

Notes for the implementer (not part of the diff, just context): the outer `div` is a non-scrolling `relative` wrapper that now owns the border/rounding/background chrome and the caller's `className` (sizing/overrides land here exactly as before — e.g. `"h-full rounded-none border-0"` from `issue-run-panel.tsx` still cleanly overrides `rounded-md`/`border` via `cn()`'s `tailwind-merge`, and `"h-[400px]"` from the task-detail page still works, since child sizing uses `absolute inset-0` rather than percentage heights). The inner `div` is the actual scrolling pane, filling the wrapper via `inset-0` regardless of whether the wrapper's height came from a percentage (`h-full`) or a fixed value (`h-[400px]`). The floating "jump to bottom" button is a sibling of the scrolling pane (not inside it), so it stays visually pinned to the wrapper's corner instead of scrolling away with the content.

- [ ] **Step 2: Append the live-cursor CSS** — in `apps/web/src/app/globals.css`, find this existing block (added by an earlier plan):

```css
@media (prefers-reduced-motion: no-preference) {
  .rise {
    animation: forge-rise 0.3s ease-out both;
  }
  .rise-1 { animation-delay: 40ms; }
  .rise-2 { animation-delay: 80ms; }
  .rise-3 { animation-delay: 120ms; }
  .rise-4 { animation-delay: 160ms; }
  .rise-5 { animation-delay: 200ms; }
  .rise-6 { animation-delay: 240ms; }
  .console-line-in {
    animation: forge-console-line-in 0.2s ease-out both;
  }
}
```

and replace it with (adding `.console-cursor` inside the same media block):

```css
@media (prefers-reduced-motion: no-preference) {
  .rise {
    animation: forge-rise 0.3s ease-out both;
  }
  .rise-1 { animation-delay: 40ms; }
  .rise-2 { animation-delay: 80ms; }
  .rise-3 { animation-delay: 120ms; }
  .rise-4 { animation-delay: 160ms; }
  .rise-5 { animation-delay: 200ms; }
  .rise-6 { animation-delay: 240ms; }
  .console-line-in {
    animation: forge-console-line-in 0.2s ease-out both;
  }
  .console-cursor {
    animation: forge-console-cursor 1s step-end infinite;
  }
}
```

Then find this existing block:

```css
@keyframes forge-console-line-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

and replace it with (adding a new keyframe after it, same file, still above the `.title-glow` section):

```css
@keyframes forge-console-line-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes forge-console-cursor {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
```

(Under reduced motion, `.console-cursor` has no animation applied at all — the `▍` character simply renders solid/visible, never hidden. That's the correct fallback per the spec: no separate rule needed.)

- [ ] **Step 3: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: all 4 projects `Done`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/session-log-view.tsx apps/web/src/app/globals.css
git commit -m "feat(console): colorized per-line tags, timestamps, blinking live cursor, smart auto-scroll pin"
```

---

### Task 3: Verification (controller-run)

- [ ] **Step 1: Automated** — from repo root: `pnpm typecheck && pnpm --filter web test`. Expected: 4/4 Done; all tests pass.

- [ ] **Step 2: Browser walkthrough**, both consumers, dark AND light:
  - **Repo console** (`/repos/{owner}/{repo}?issue=N` with a resolved+reviewed issue, e.g. `paulmeller/forge-sandbox#7`) — Run Output panel's log tail shows colorized `[tag]` prefixes matching role (session=live-green, agent/tool/assistant=amber, forge=neutral) and a mono timestamp before each tag. Scroll up mid-render (if enough lines exist) and confirm the view does NOT force back to bottom; if a live task is available, confirm the "↓ N new" pill appears while scrolled up and clicking it returns to bottom and hides the pill.
  - **Task detail page** (`/missions/{id}/tasks/{taskId}`) — same log tail renders correctly at its fixed `h-[400px]` height, same colorization, same scroll-pin behavior. Confirm the panel's border/rounding still renders correctly (regression check for the wrapper restructure).
  - **Live cursor**: find or trigger a task where `isLive` is true (a `queued`/`dispatching`/`running` task) and confirm the blinking `▍` cursor appears after the last line; confirm it is absent for completed tasks.
  - **Error coloring**: find a task whose ledger contains a failed tool call or a `session.error` event (or inspect via the browser's dev tools / a test fixture) and confirm that line's tag renders `text-destructive` (red) regardless of its role.
  - Console: no errors or hydration warnings in either theme.

- [ ] **Step 3: Ledger entry** in `.superpowers/sdd/progress.md`; fix anything found first.

---

## Self-Review Notes

- Spec coverage: design point 1 (colorized tags) → Task 2 Step 1's `ROLE_TAG_CLASS`/`isErrorLogEvent` usage; point 2 (timestamp) → Task 1 (`formatConsoleTime`) + Task 2 (call site); point 3 (cursor) → Task 2 Steps 1-2; point 4 (smart scroll) → Task 2 Step 1's pin/scroll logic.
- Type consistency: `isErrorLogEvent(event: LogEventLike)` and `formatConsoleTime(date: Date)` signatures match their Task 2 call sites exactly (`formatConsoleTime(new Date(event.createdAt))` handles the `Date | string` union on `LogEvent.createdAt`).
- Placeholder scan: every step carries complete code; the wrapper-restructure rationale is explained inline (as implementer context, not a placeholder) since it's the one design decision not spelled out verbatim in the spec.
- `formatLogLine`'s test suite and return type are untouched, per Global Constraints — Task 1 Step 1 only adds new tests, doesn't modify existing ones.
