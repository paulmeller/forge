# UI Polish Plan A — Systems + Page Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §1-§5 primitives (status labels, SectionLabel, DataChip, motion utilities, title glow) and the home / missions / repo-console / mission-detail polish from `docs/superpowers/specs/2026-07-18-ui-polish-design.md` §6.

**Architecture:** One new lib (`status-labels`), two tiny presentational components (`SectionLabel`, `DataChip`), additive CSS utilities in `globals.css` (motion + glow, all behind `prefers-reduced-motion` where animated), then targeted edits to existing components/pages. No new dependencies, no schema changes, no route changes.

**Tech Stack:** Next.js App Router, Tailwind v4 CSS-first, shadcn/ui new-york radix, vitest (node env — lib tests only).

## Global Constraints

- Every commit leaves the whole monorepo `pnpm typecheck` clean (run from repo root; all 4 projects `Done`).
- Do NOT run `pnpm lint` (pre-existing repo-wide breakage — out of scope).
- Semantic tokens only; no raw palette classes; no `space-y-*`/`space-x-*`; Tailwind v4 arbitrary vars are `[var(--x)]` never bare `[--x]`.
- Machine status strings (snake_case) remain in console surfaces ONLY: ledger event rows, timeline raw payloads, session-log panes. Everywhere else user-facing, use `statusLabel()`.
- Exact humanized strings come from the spec §1 table — do not invent alternatives.
- Motion: CSS-only, inside `@media (prefers-reduced-motion: no-preference)`; one orchestrated load moment per page; no scroll triggers.
- Dates/numbers: `'en-US'` locale always (hydration-safety house rule).
- Line numbers below were captured at plan time and may drift a few lines — match on the quoted old strings (unique per file).

---

### Task 1: status-labels lib + adoption

**Files:**
- Create: `apps/web/src/lib/status-labels.ts`
- Create: `apps/web/src/lib/status-labels.test.ts`
- Modify: `apps/web/src/components/task-status-badge.tsx`
- Modify: `apps/web/src/components/mission-status-badge.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx`
- Modify: `apps/web/src/components/mission-filters.tsx`

**Interfaces:**
- Produces: `statusLabel(s: string): string` and `STATUS_LABELS: Record<string, string>` — used by Tasks 2 and 4.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/lib/status-labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { STATUS_LABELS, statusLabel } from './status-labels';

describe('statusLabel', () => {
  it('maps every known machine string to a non-snake human label', () => {
    for (const [machine, label] of Object.entries(STATUS_LABELS)) {
      expect(statusLabel(machine)).toBe(label);
      expect(label).not.toMatch(/_/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('spot-checks the spec table', () => {
    expect(statusLabel('awaiting_review')).toBe('Needs review');
    expect(statusLabel('fix_review')).toBe('Reviewing fix');
    expect(statusLabel('awaiting_ci')).toBe('Waiting on CI');
    expect(statusLabel('opening_pr')).toBe('Opening PR');
    expect(statusLabel('not_reproduced')).toBe('Not reproduced');
    expect(statusLabel('running')).toBe('Running');
  });

  it('falls back to the raw string for unknown values', () => {
    expect(statusLabel('some_future_status')).toBe('some_future_status');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter web test -- status-labels`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `apps/web/src/lib/status-labels.ts`:

```ts
/**
 * Machine status → human label (spec §1, docs/superpowers/specs/2026-07-18-ui-polish-design.md).
 * snake_case strings stay user-visible ONLY in console surfaces (ledger, timeline
 * raw payloads, session logs). Everywhere else, render statusLabel(s).
 */
export const STATUS_LABELS: Record<string, string> = {
  // Task statuses
  queued: 'Queued',
  dispatching: 'Dispatching',
  running: 'Running',
  turn_ended: 'Turn ended',
  opening_pr: 'Opening PR',
  awaiting_ci: 'Waiting on CI',
  awaiting_verify: 'Verifying',
  awaiting_ai_review: 'AI review',
  merging: 'Merging',
  awaiting_review: 'Needs review',
  failed: 'Failed',
  merged: 'Merged',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
  // Triage headlines
  reproducing: 'Reproducing',
  fixing: 'Fixing',
  fix_review: 'Reviewing fix',
  fixed: 'Fixed',
  not_reproduced: 'Not reproduced',
  fix_skipped: 'Fix skipped',
  // Mission statuses
  draft: 'Draft',
  planning: 'Planning',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `pnpm --filter web test -- status-labels`
Expected: 3 tests pass.

- [ ] **Step 5: Adopt in badges** —
  - `task-status-badge.tsx`: add `import { statusLabel } from '@/lib/status-labels';` and change `<Badge variant={VARIANT[status] ?? 'outline'}>{status}</Badge>` to `<Badge variant={VARIANT[status] ?? 'outline'}>{statusLabel(status)}</Badge>`.
  - `mission-status-badge.tsx`: add the same import and change `<Badge variant={VARIANT[status] ?? 'outline'}>{status}</Badge>` to `<Badge variant={VARIANT[status] ?? 'outline'}>{statusLabel(status)}</Badge>`.

- [ ] **Step 6: Adopt in workspace-list** — in `workspace-list.tsx`, add `import { statusLabel } from '@/lib/status-labels';` and inside `renderRow`, change the headline render `{row.group.headline}` to `{statusLabel(row.group.headline)}` (single occurrence, inside the `inline-flex items-center gap-1` span).

- [ ] **Step 7: Adopt in mission filters** — in `mission-filters.tsx`, add `import { statusLabel } from '@/lib/status-labels';` and change the status ToggleGroupItem body from `{s}` to `{statusLabel(s)}`. Backend items stay machine-mono (they are backend ids, console voice). Kind items unchanged.

- [ ] **Step 8: Typecheck + full web tests**

Run from repo root: `pnpm typecheck && pnpm --filter web test`
Expected: 4/4 `Done`; all tests pass (now 20 files).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/status-labels.ts apps/web/src/lib/status-labels.test.ts apps/web/src/components/task-status-badge.tsx apps/web/src/components/mission-status-badge.tsx "apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx" apps/web/src/components/mission-filters.tsx
git commit -m "feat(ui): humanized status vocabulary — statusLabel map adopted by every user-facing badge"
```

---

### Task 2: SectionLabel + DataChip + chip grammar

**Files:**
- Create: `apps/web/src/components/section-label.tsx`
- Create: `apps/web/src/components/data-chip.tsx`
- Modify: `apps/web/src/components/progress-pill.tsx` (MissionProgressPill only)
- Modify: `apps/web/src/components/queue-section.tsx`
- Modify: `apps/web/src/components/missions-table.tsx`
- Modify: `apps/web/src/components/mission-filters.tsx`

**Interfaces:**
- Consumes: `statusLabel` (Task 1) — no; this task does not need it (badges already humanized).
- Produces: `SectionLabel({children, className})`, `DataChip({children, className, title})` — used by Task 4.
- `MissionProgressPill({rollup})` and `TaskProgressPill` signatures unchanged (internal rendering only).

- [ ] **Step 1: Create `apps/web/src/components/section-label.tsx`:**

```tsx
import { cn } from '@/lib/utils';

/** The one blessed section/eyebrow label style (spec §2). */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/components/data-chip.tsx`:**

```tsx
import { cn } from '@/lib/utils';

/** Mono data chip for numbers and identifiers (spec §3). */
export function DataChip({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 3: Cap MissionProgressPill chips** — in `progress-pill.tsx`, replace the entire `MissionProgressPill` function body (keep the `MissionRollup` type and everything else) with:

```tsx
export function MissionProgressPill({ rollup }: { rollup: MissionRollup }) {
  const settled =
    rollup.merged + rollup.resolved + rollup.awaitingReview + rollup.abandoned + rollup.failed;
  const pct = rollup.total === 0 ? 0 : Math.round((settled / rollup.total) * 100);

  // Priority-ordered status chips; pct + cost always render, so at most 2
  // status chips are visible (4-chip cap, spec §3) — the rest collapse to +N.
  const statusChips: Array<{ key: string; tone: 'live' | 'good' | 'bad' | 'muted'; label: string }> = [];
  if (rollup.inFlight > 0) statusChips.push({ key: 'inflight', tone: 'live', label: `${rollup.inFlight} in flight` });
  if (rollup.failed > 0) statusChips.push({ key: 'failed', tone: 'bad', label: `${rollup.failed} failed` });
  if (rollup.merged > 0) statusChips.push({ key: 'merged', tone: 'good', label: `${rollup.merged} merged` });
  if (rollup.awaitingReview > 0) statusChips.push({ key: 'review', tone: 'muted', label: `${rollup.awaitingReview} review` });
  if (rollup.resolved > 0) statusChips.push({ key: 'triaged', tone: 'muted', label: `${rollup.resolved} triaged` });
  if (rollup.abandoned > 0) statusChips.push({ key: 'abandoned', tone: 'muted', label: `${rollup.abandoned} abandoned` });
  const visible = statusChips.slice(0, 2);
  const hidden = statusChips.length - visible.length;

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <Chip tone="muted">
        <span className="font-semibold text-foreground">{pct}%</span>
        <span className="ml-1 text-muted-foreground">{settled}/{rollup.total}</span>
      </Chip>
      {visible.map((c) => (
        <Chip key={c.key} tone={c.tone}>{c.label}</Chip>
      ))}
      {hidden > 0 && <Chip tone="muted">+{hidden}</Chip>}
      <Chip tone="muted">{formatUsd(rollup.spentUsd)}</Chip>
      <span className="text-[11px] tabular-nums text-muted-foreground" suppressHydrationWarning>
        {rollup.lastEventAt ? formatRelative(rollup.lastEventAt) : '—'}
      </span>
    </div>
  );
}
```

(The old `hasFailures` variable disappears; relative time becomes plain text per spec §3 "time is text, not a chip"; `flex-wrap` removed so the cell never wraps.)

- [ ] **Step 4: Queue-section chip grammar** — in `queue-section.tsx`:
  - Replace the `CostChip` function entirely with an import-and-use of DataChip. Delete the `CostChip` function and its usage; add `import { DataChip } from '@/components/data-chip';` and remove the now-unused `formatUsd` import ONLY if no longer referenced (it will still be referenced — see below — so keep it).
  - Inside the `rows.map` callback, replace the right-hand chip cluster (the `div.flex.shrink-0.items-center.gap-2` block) with:

```tsx
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  {rollup ? <TaskProgressPill rollup={rollup} /> : null}
                  {task.prUrl ? <PrChip prUrl={task.prUrl} prNumber={task.prNumber} linked={false} /> : null}
                  {(() => {
                    const usd = tokensToUsd(task.costTokens);
                    const chipCount =
                      (rollup ? 1 : 0) + (task.prUrl ? 1 : 0) + (usd > 0 ? 1 : 0) + 1; // +1 status badge
                    return (
                      <>
                        {usd > 0 ? <DataChip>{formatUsd(usd)}</DataChip> : null}
                        {isIssueMission && chipCount < 4 ? (
                          <Badge variant="outline" className="text-[10px]">
                            Issue
                          </Badge>
                        ) : null}
                      </>
                    );
                  })()}
                  <TaskStatusBadge status={task.status} haltReason={task.haltReason} />
                  <span
                    className="w-14 text-right text-[11px] tabular-nums text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {formatRelative(task.updatedAt)}
                  </span>
                </div>
```

  - Add `import { formatUsd } from '@/lib/format';` is already present via the existing import line (`formatRelative, formatUsd`) — keep it. Canonical order preserved: progress, PR, cost, kind, status, time-as-text; the kind chip is the first to drop at the cap (spec §3 drop order).

- [ ] **Step 5: Missions-table subtitle + backend + nowrap** — in `missions-table.tsx`:
  - Add `import { DataChip } from '@/components/data-chip';`.
  - Subtitle dedupe: change

```tsx
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {missionShapeLabel(mission)}
                  </p>
```

  to

```tsx
                  {mission.issueRef ? null : (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {missionShapeLabel(mission)}
                    </p>
                  )}
```

  (Issue missions' names already contain the ref — never render the same string twice, spec §6.)
  - Backend cell: change `<TableCell className="font-mono text-xs">{mission.backend}</TableCell>` to

```tsx
                <TableCell>
                  <DataChip title={mission.backend}>
                    {mission.backend === 'managed-agents' ? 'ma' : 'gw'}
                  </DataChip>
                </TableCell>
```

- [ ] **Step 6: Filter captions** — in `mission-filters.tsx`, add `import { SectionLabel } from '@/components/section-label';`, then restructure the return so each ToggleGroup gets a caption. Replace the root `<div className="flex flex-wrap items-center gap-2">` structure with grouped columns (keep every ToggleGroup/Input/Clear element byte-identical inside):

```tsx
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1">
        <SectionLabel>Status</SectionLabel>
        {/* existing status ToggleGroup unchanged */}
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel>Backend</SectionLabel>
        {/* existing backend ToggleGroup unchanged */}
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel>Search</SectionLabel>
        {/* existing Input unchanged */}
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel>Kind</SectionLabel>
        {/* existing kind ToggleGroup unchanged */}
      </div>
      {/* existing Clear button unchanged, rendered last inside the root div */}
    </div>
  );
```

  Delete the three `<span className="mx-1 h-4 w-px bg-border" />` divider spans (captions replace them as separators).

- [ ] **Step 7: Typecheck + tests**

Run from repo root: `pnpm typecheck && pnpm --filter web test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/section-label.tsx apps/web/src/components/data-chip.tsx apps/web/src/components/progress-pill.tsx apps/web/src/components/queue-section.tsx apps/web/src/components/missions-table.tsx apps/web/src/components/mission-filters.tsx
git commit -m "feat(ui): chip grammar — SectionLabel + DataChip, 4-chip cap with +N overflow, labeled filters"
```

---

### Task 3: Motion utilities + title glow + home hero tiles

**Files:**
- Modify: `apps/web/src/app/globals.css` (append only)
- Modify: `apps/web/src/components/page-shell.tsx`
- Modify: `apps/web/src/components/session-log-view.tsx`
- Modify: `apps/web/src/app/(app)/home/page.tsx`
- Modify: `apps/web/src/app/(app)/missions/page.tsx`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/page.tsx`

**Interfaces:**
- Produces: CSS classes `.rise`, `.rise-1`…`.rise-6`, `.console-line-in`, `.title-glow` — used by Task 4 as well.

- [ ] **Step 1: Append to `globals.css`** (at the end of the file):

```css
/* ---- Motion utilities (spec §4) — CSS-only, reduced-motion safe ---- */
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

@keyframes forge-rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

@keyframes forge-console-line-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ---- Title glow (spec §5) — the one signature; dark mode only ---- */
.title-glow {
  position: relative;
}
.dark .title-glow::before {
  content: '';
  position: absolute;
  left: -80px;
  right: -80px;
  top: -60px;
  height: 220px;
  background: radial-gradient(
    600px circle at 20% 20%,
    color-mix(in oklab, var(--primary) 5%, transparent),
    transparent 70%
  );
  pointer-events: none;
}
```

- [ ] **Step 2: PageHeader gets the glow** — in `page-shell.tsx`, change the PageHeader root div class from `"mb-8 flex items-start justify-between gap-4"` to `"title-glow mb-8 flex items-start justify-between gap-4"`.

- [ ] **Step 3: Console lines fade in** — in `session-log-view.tsx`, change the line render `<div key={event.id} className="whitespace-pre-wrap break-words">` to `<div key={event.id} className="console-line-in whitespace-pre-wrap break-words">`.

- [ ] **Step 4: Home — hero tiles + stagger.** In `home/page.tsx`:
  - Replace the entire metrics grid (the `div.mb-8.grid` block with its four `<Card className="px-4 py-3">` tiles) with linked hero tiles:

```tsx
      <div className="rise rise-1 mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Link href="/missions?status=completed" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.mergedThisWeek}</p>
            <p className="text-xs text-muted-foreground">PRs merged this week</p>
          </Card>
        </Link>
        <Link href="/missions?status=running" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.activeAgents}</p>
            <p className="text-xs text-muted-foreground">Active agents</p>
          </Card>
        </Link>
        <Link href="/missions" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">${stats.spentUsd.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">Total spend</p>
          </Card>
        </Link>
        <Link href="/repos" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.connectedRepos}</p>
            <p className="text-xs text-muted-foreground">Connected repos</p>
          </Card>
        </Link>
      </div>
```

  - Stagger the queue: change `<div className="flex flex-col gap-6">` to `<div className="flex flex-col gap-6">` wrapping each QueueSection in a staggered div:

```tsx
      <div className="flex flex-col gap-6">
        <div className="rise rise-2">
          <QueueSection title="Needs you" rows={needsYou} empty="Nothing waiting on you." />
        </div>
        <div className="rise rise-3">
          <QueueSection
            title="Working"
            rows={nowRunning}
            rollups={runningRollups}
            empty="Nothing running right now."
            live
          />
        </div>
        <div className="rise rise-4">
          <QueueSection
            title="Recently done"
            rows={recentOutcomes}
            empty="No merged PRs or resolved issues yet."
          />
        </div>
      </div>
```

- [ ] **Step 5: Missions page stagger** — in `missions/page.tsx`, change `<div className="mb-4">` (wrapping MissionFilters) to `<div className="rise rise-1 mb-4">`, and wrap the MissionsTable in a staggered div:

```tsx
      <div className="rise rise-2">
        <MissionsTable
          missions={allMissions}
          rollups={rollups}
          sparklines={sparklines}
          hasFilters={hasFilters}
        />
      </div>
```

- [ ] **Step 6: Mission detail glow + stagger** — in `missions/[missionId]/page.tsx`:
  - Header glow: change the header wrapper `<div className="mb-6 shrink-0">` to `<div className="title-glow mb-6 shrink-0">`.
  - Stagger: change the tasks `<section className="col-span-12 min-w-0 lg:col-span-8">` to `<section className="rise rise-1 col-span-12 min-w-0 lg:col-span-8">`; the sidebar `<aside className="col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-4">` to `<aside className="rise rise-2 col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-4">`; the timeline `<section className="flex min-h-0 min-w-0 flex-1 flex-col">` to `<section className="rise rise-3 flex min-h-0 min-w-0 flex-1 flex-col">`.

- [ ] **Step 7: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: 4/4 `Done`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/src/components/page-shell.tsx apps/web/src/components/session-log-view.tsx "apps/web/src/app/(app)/home/page.tsx" "apps/web/src/app/(app)/missions/page.tsx" "apps/web/src/app/(app)/missions/[missionId]/page.tsx"
git commit -m "feat(ui): motion system (rise stagger, console fade) + title glow + linked hero tiles"
```

---

### Task 4: Repo console polish

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/work-on-it-button.tsx`

**Interfaces:**
- Consumes: `SectionLabel` (Task 2), `.title-glow` (Task 3), `statusLabel` (Task 1).

- [ ] **Step 1: Header — identifier goes mono + glow** — in `page.tsx`:
  - Change `<h1 className="font-title text-3xl uppercase tracking-tight">{repo}</h1>` to `<h1 className="truncate font-mono text-2xl font-semibold tracking-tight">{repo}</h1>`.
  - Change the header wrapper `<div className="mb-4 flex items-start justify-between gap-4">` to `<div className="title-glow mb-4 flex items-start justify-between gap-4">`.
  - Add `min-w-0` to the h1's parent: the inner `<div>` directly wrapping the h1 block becomes `<div className="min-w-0">` (this plus `truncate` prevents any long-name wrap from ever pushing the toolbar).

- [ ] **Step 2: RUN OUTPUT frame** — in `issue-run-panel.tsx`:
  - Add `import { SectionLabel } from '@/components/section-label';`.
  - Replace this block (current lines ~151-166):

```tsx
          <div className="min-h-0 min-w-0 flex-[2] overflow-y-auto">
            <AttemptFileBrowser task={task} ledger={ledger} />
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SessionLogView
              taskId={task.id}
              isLive={isLive}
              initialEvents={ledger}
              maxLines={300}
              className="h-full"
            />
          </div>
```

  with:

```tsx
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
            <div className="shrink-0 border-b bg-muted/40 px-3 py-1.5">
              <SectionLabel>Run output</SectionLabel>
            </div>
            <div className="min-h-0 min-w-0 flex-[2] overflow-y-auto p-3">
              <AttemptFileBrowser task={task} ledger={ledger} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t">
              <SessionLogView
                taskId={task.id}
                isLive={isLive}
                initialEvents={ledger}
                maxLines={300}
                className="h-full rounded-none border-0"
              />
            </div>
          </div>
```

  (SessionLogView's own border/rounding is neutralized via className so the frame owns the chrome; `cn()` merge handles the override.)

- [ ] **Step 3: In-flight state is a status line, not a disabled button** — in `work-on-it-button.tsx`, add `import { statusLabel } from '@/lib/status-labels';` and replace the `inFlight` early return with:

```tsx
  const inFlight = headline !== null && !TERMINAL.has(headline);
  if (inFlight) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {(headline === 'reproducing' || headline === 'fixing') && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live" aria-hidden />
        )}
        {statusLabel(headline)}
        {headline === 'fix_review' ? ' — check the PR above' : null}
      </p>
    );
  }
```

  Then delete the now-unused `IN_FLIGHT_LABEL` constant.

- [ ] **Step 4: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: 4/4 `Done`.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/work-on-it-button.tsx"
git commit -m "polish(console): mono repo header, framed run output, in-flight status line"
```

---

### Task 5: Budget uncapped state + console timestamps + locale pins

**Files:**
- Modify: `apps/web/src/components/budget-gauge.tsx`
- Modify: `apps/web/src/components/role-tagged-event.tsx`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`

**Interfaces:**
- `BudgetGauge` props unchanged; rendering changes only.

- [ ] **Step 1: Budget gauge** — in `budget-gauge.tsx`:
  - Pin locales in the two local formatters: `new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })` → `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`, and `new Intl.NumberFormat()` → `new Intl.NumberFormat('en-US')`.
  - Uncapped state: replace the `BudgetGauge` return statement's outer JSX with a capped/uncapped branch. The full new return:

```tsx
  const uncapped = budgetUsd === null && budgetTokens === null;
  if (uncapped) {
    return (
      <p className="text-xs text-muted-foreground">
        No cap · <span className="font-mono tabular-nums">{formatUsd(spentUsd)}</span> spent ·{' '}
        <span className="font-mono tabular-nums">{formatTokens(spentTokens)}</span> tokens
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {budgetUsd !== null && (
        <div>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">USD</span>
            <span className="font-mono tabular-nums">
              {formatUsd(spentUsd)} <span className="text-muted-foreground">/ {formatUsd(budgetUsd)}</span>
            </span>
          </div>
          <Bar pct={usdPct} threshold={thresholdPct} tone={tone(usdPct)} />
        </div>
      )}
      {budgetTokens !== null && (
        <div>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Tokens</span>
            <span className="font-mono tabular-nums">
              {formatTokens(spentTokens)}{' '}
              <span className="text-muted-foreground">/ {formatTokens(budgetTokens)}</span>
            </span>
          </div>
          <Bar pct={tokenPct} threshold={thresholdPct} tone={tone(tokenPct)} />
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">Auto-pause at {thresholdPct}%.</p>
    </div>
  );
```

  (Bars render ONLY for capped axes, spec §6; the `uncapped` branch is placed after the existing `usdPct`/`tokenPct`/`tone` declarations.)

- [ ] **Step 2: Timeline timestamps get the console voice** — in `role-tagged-event.tsx`, change the timestamp span class from `"ml-auto shrink-0 text-[10px] text-muted-foreground"` to `"ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"`.

- [ ] **Step 3: Locale pin in task detail** — in `tasks/[taskId]/page.tsx`, change `new Intl.NumberFormat().format(` to `new Intl.NumberFormat('en-US').format(` (single occurrence).

- [ ] **Step 4: Typecheck + web tests**

Run from repo root: `pnpm typecheck && pnpm --filter web test`
Expected: clean (repo-budget tests exercise neither formatter branch removed).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/budget-gauge.tsx apps/web/src/components/role-tagged-event.tsx "apps/web/src/app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx"
git commit -m "polish(mission): honest uncapped budget state, mono console timestamps, en-US number pins"
```

---

### Task 6: Verification sweep (controller-run)

- [ ] **Step 1: Automated** — from repo root: `pnpm typecheck && pnpm --filter web test`. Expected: 4/4 Done; 20 test files pass (status-labels added).

- [ ] **Step 2: Gates** —

```bash
cd apps/web/src
# machine strings must not render in non-console UI: badges all go through statusLabel now
grep -rn "NumberFormat(undefined\|NumberFormat()" --include="*.tsx" --include="*.ts" . | grep -v node_modules
# expect: empty
grep -rn "animate-" --include="*.tsx" . | grep -v components/ui/ | grep -v "animate-pulse"
# expect: empty (rise/console-line-in are CSS classes, not Tailwind animate-*)
```

- [ ] **Step 3: Browser walkthrough** (dev on :3100, dark AND light; plus DevTools reduced-motion emulation on one page):
  - `/home` — tiles are large linked numerals with hover; sections rise in staggered on load; queue badges say "Needs review" not `awaiting_review`; no chip wrap.
  - `/missions` — filter groups labeled STATUS/BACKEND/SEARCH/KIND; status pills humanized; progress cell single-line with `+N` when crowded; backend chips `ma`/`gw` with title tooltip; issue-mission rows show no duplicate subtitle.
  - Repo console — mono header (no wrap, toolbar intact at ~1400px), title glow dark-only, RUN OUTPUT framed with header bar, stage badges humanized ("Reviewing fix"/"Needs review"), in-flight footer is a status line with pulsing dot (not a button).
  - Mission detail — header glow; sections rise; Budget shows "No cap · $X spent · Y tokens" with NO bars for the uncapped mission; timeline timestamps mono.
  - Reduced-motion emulation: no rise animation, content instantly visible.
  - Console: no errors/hydration warnings.

- [ ] **Step 4: Ledger entry** in `.superpowers/sdd/progress.md`; fix anything found first.

---

## Self-Review Notes

- Spec coverage: §1 → Task 1; §2 (SectionLabel; font-title rule applied at the one violating site, the repo header) → Tasks 2+4; §3 → Task 2; §4 → Task 3 (+ SessionLogView line class); §5 → Task 3 (+ Task 4 applies it to the console header); §6 home/missions/console/mission-detail → Tasks 3/2/4/5. §6 Repos+Setup are Plan B by design.
- Type consistency: `SectionLabel`/`DataChip` props defined in Task 2 match all Task 2/4 call sites; `statusLabel` signature consistent across Tasks 1/4.
- Placeholder scan: every code step carries complete code or exact old→new strings; the two "existing X unchanged" markers in Task 2 Step 6 refer to blocks quoted in full in the current file and moved verbatim, with the surrounding new wrapper shown.
- Known interaction: Task 2 Step 4 rewrites the same `queue-section.tsx` region Task 3 does NOT touch (Task 3 touches only home/page.tsx wrappers) — no cross-task edit conflicts.
