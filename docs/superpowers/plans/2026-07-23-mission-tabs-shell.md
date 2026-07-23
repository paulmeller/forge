# Mission Detail Tab Bar — Shell + Overview Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mission detail page a shared header + tab bar (Overview / Pipeline / Tools / Tasks, the last three disabled for now) via a new `layout.tsx`, without changing any existing page's visible behavior except relocating where the header renders from.

**Architecture:** A Next.js App Router `layout.tsx` at `apps/web/src/app/(app)/missions/[missionId]/` fetches the mission (and, for one specific button's disabled state, the task count) once, renders the header and a new `MissionTabs` component, then `{children}`. `page.tsx` loses its header block but is otherwise untouched. `MissionTabs` is plain `next/link` + `usePathname()` — not Radix's `Tabs`/`TabsTrigger` primitives, which require a `Tabs.Root` context incompatible with route-driven (rather than client-state-driven) navigation.

**Tech Stack:** Next.js App Router (layout.tsx), React Server Components, `next/link` + `next/navigation`'s `usePathname`, Vitest (`environment: 'node'`, no DOM/RTL — confirmed no `.test.tsx` files exist anywhere in this app today).

## Global Constraints

- The header's exact existing conditions must be preserved verbatim: `mission.status === 'draft'` shows Plan Mission (disabled when `missingSource`, computed identically to today: `mission.plannerStrategy === 'triage' ? !mission.issueQuery?.trim() : targetRepos.length === 0`); `'planning'` shows Review-plan link + Start Mission (disabled when `tasks.length === 0`); `'running'` shows Pause; `'paused'` shows Resume; `mission.plannerStrategy === 'triage'` additionally shows the View-by-issue link. `LiveRefresh` renders when `mission.status === 'running' || mission.status === 'planning'`.
- `ConsoleShell` wraps the layout's output, not `page.tsx`'s — no double `<main>` nesting.
- `MissionTabs` does not import Radix's `Tabs`/`TabsList`/`TabsTrigger` — it reuses their exact className strings as plain literals, since Radix's `Trigger` requires a `Tabs.Root` context this route-driven design doesn't have.
- Disabled tabs (Pipeline, Tools, Tasks) render as `<span aria-disabled="true">`, not a `Link` — links have no native disabled state, so a non-interactive span is the correct semantic choice, not a workaround.
- No new npm dependency.

---

## Task 1: Mission layout shell (header relocation + tab bar)

**Files:**
- Create: `apps/web/src/components/mission-tabs.tsx`
- Create: `apps/web/src/components/mission-tabs.test.ts`
- Create: `apps/web/src/app/(app)/missions/[missionId]/layout.tsx`
- Modify: `apps/web/src/app/(app)/missions/[missionId]/page.tsx`

**Interfaces:**
- Produces: `activeMissionTab(pathname: string, missionId: string): 'overview' | 'pipeline' | 'tools' | 'tasks' | null` (exported pure function, unit-tested directly) and `MissionTabs({ missionId }: { missionId: string })` (the component, using that function internally). `layout.tsx` imports `MissionTabs` from `@/components/mission-tabs`.

- [ ] **Step 1: Write the failing test for the active-tab logic**

Create `apps/web/src/components/mission-tabs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { activeMissionTab } from './mission-tabs';

describe('activeMissionTab', () => {
  it('matches Overview only on the exact mission root path', () => {
    expect(activeMissionTab('/missions/msn_1', 'msn_1')).toBe('overview');
  });

  it('does not match Overview for a sub-route (exact match, not prefix)', () => {
    expect(activeMissionTab('/missions/msn_1/ledger', 'msn_1')).toBeNull();
  });

  it('matches Pipeline by prefix', () => {
    expect(activeMissionTab('/missions/msn_1/pipeline', 'msn_1')).toBe('pipeline');
  });

  it('matches Tools by prefix', () => {
    expect(activeMissionTab('/missions/msn_1/tools', 'msn_1')).toBe('tools');
  });

  it('matches Tasks by prefix, including nested sub-paths', () => {
    expect(activeMissionTab('/missions/msn_1/tasks', 'msn_1')).toBe('tasks');
    expect(activeMissionTab('/missions/msn_1/tasks/tsk_1', 'msn_1')).toBe('tasks');
  });

  it('returns null for unrelated routes (e.g. ledger, plan, retrospective, issues)', () => {
    expect(activeMissionTab('/missions/msn_1/plan', 'msn_1')).toBeNull();
    expect(activeMissionTab('/missions/msn_1/retrospective', 'msn_1')).toBeNull();
    expect(activeMissionTab('/missions/msn_1/issues', 'msn_1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/components/mission-tabs.test.ts`
Expected: FAIL — the module `./mission-tabs` does not exist yet.

- [ ] **Step 3: Implement `mission-tabs.tsx`**

Create `apps/web/src/components/mission-tabs.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

type TabKey = 'overview' | 'pipeline' | 'tools' | 'tasks';

const TABS: Array<{ key: TabKey; label: string; disabled: boolean }> = [
  { key: 'overview', label: 'Overview', disabled: false },
  { key: 'pipeline', label: 'Pipeline', disabled: true },
  { key: 'tools', label: 'Tools', disabled: true },
  { key: 'tasks', label: 'Tasks', disabled: true },
];

function tabHref(missionId: string, key: TabKey): string {
  return key === 'overview' ? `/missions/${missionId}` : `/missions/${missionId}/${key}`;
}

/**
 * Which tab (if any) a given pathname belongs to. Overview matches only the
 * exact mission root — a prefix match would also light it up for /ledger,
 * /plan, /retrospective, /issues, which are separate, un-tabbed routes.
 * The other three match by prefix so nested sub-paths (e.g. a future
 * /tasks/[taskId]) still highlight their parent tab.
 */
export function activeMissionTab(pathname: string, missionId: string): TabKey | null {
  const overviewHref = tabHref(missionId, 'overview');
  if (pathname === overviewHref) return 'overview';
  for (const tab of TABS) {
    if (tab.key === 'overview') continue;
    if (pathname.startsWith(tabHref(missionId, tab.key))) return tab.key;
  }
  return null;
}

export function MissionTabs({ missionId }: { missionId: string }) {
  const pathname = usePathname();
  const active = activeMissionTab(pathname, missionId);

  return (
    <nav className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
      {TABS.map((tab) => {
        const isActive = active === tab.key;
        const triggerClassName = cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all',
          isActive && 'bg-background text-foreground shadow',
        );

        if (tab.disabled) {
          return (
            <span
              key={tab.key}
              aria-disabled="true"
              className={cn(triggerClassName, 'cursor-not-allowed opacity-50')}
            >
              {tab.label}
            </span>
          );
        }

        return (
          <Link key={tab.key} href={tabHref(missionId, tab.key)} className={triggerClassName}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/components/mission-tabs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Read the current `page.tsx` header block once more to copy it exactly**

Run: `sed -n '1,132p' apps/web/src/app/\(app\)/missions/\[missionId\]/page.tsx`

Confirm the header block (lines 56-131 as of this plan's writing: the `<div className="title-glow mb-6 shrink-0">...</div>`) matches what's transcribed into Step 6 below verbatim, adjusting only line numbers if the file has drifted since this plan was written. If it has drifted, copy the current text, not the plan's — the plan's copy is a snapshot, the file is the source of truth.

- [ ] **Step 6: Create `layout.tsx`**

Create `apps/web/src/app/(app)/missions/[missionId]/layout.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ConsoleShell } from '@/components/console-shell';
import { LiveRefresh } from '@/components/live-refresh';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { MissionTabs } from '@/components/mission-tabs';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';

import { MissionActionButton } from './mission-actions';

export const dynamic = 'force-dynamic';

export default async function MissionLayout({
  params,
  children,
}: {
  params: Promise<{ missionId: string }>;
  children: React.ReactNode;
}) {
  const { missionId } = await params;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  // Duplicates page.tsx's own listTasksForMission call. No React cache()-based
  // request memoization exists anywhere in this codebase today (checked) —
  // introducing that pattern for one boolean isn't worth diverging from
  // existing conventions. This is a small, accepted duplicate query.
  const tasks = await listTasksForMission(missionId);
  const targetRepos = mission.targetRepos ?? [];

  return (
    <ConsoleShell>
      <div className="title-glow mb-6 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="truncate font-title text-3xl uppercase tracking-tight">{mission.name}</h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="font-mono text-[11px] text-muted-foreground">{mission.id}</p>
              {mission.status === 'running' || mission.status === 'planning' ? (
                <LiveRefresh intervalMs={5000} />
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-2">
            {mission.plannerStrategy === 'triage' ? (
              <Button asChild variant="outline">
                <Link href={`/missions/${mission.id}/issues`}>View by issue →</Link>
              </Button>
            ) : null}
            {mission.status === 'draft'
              ? (() => {
                  const isTriage = mission.plannerStrategy === 'triage';
                  const missingSource = isTriage
                    ? !mission.issueQuery?.trim()
                    : targetRepos.length === 0;
                  return (
                    <MissionActionButton
                      missionId={mission.id}
                      op="plan"
                      label="Plan Mission"
                      disabled={missingSource}
                      disabledReason={
                        missingSource
                          ? isTriage
                            ? 'Add an issue search query first'
                            : 'Add target repos first'
                          : undefined
                      }
                    />
                  );
                })()
              : null}
            {mission.status === 'planning' ? (
              <>
                <Button asChild variant="outline">
                  <Link href={`/missions/${mission.id}/plan`}>Review plan →</Link>
                </Button>
                <MissionActionButton
                  missionId={mission.id}
                  op="start"
                  label="Start Mission"
                  disabled={tasks.length === 0}
                  disabledReason={tasks.length === 0 ? 'No Tasks to dispatch' : undefined}
                />
              </>
            ) : null}
            {mission.status === 'running' ? (
              <MissionActionButton
                missionId={mission.id}
                op="pause"
                label="Pause"
                variant="outline"
              />
            ) : null}
            {mission.status === 'paused' ? (
              <MissionActionButton
                missionId={mission.id}
                op="resume"
                label="Resume"
              />
            ) : null}
          </div>
        </div>
      </div>
      <MissionTabs missionId={mission.id} />
      <div className="mt-6 flex min-h-0 flex-1 flex-col">{children}</div>
    </ConsoleShell>
  );
}
```

Note the one behavior addition versus today's `page.tsx`: the Start Mission button now also gets a `disabledReason="No Tasks to dispatch"` when disabled — today's `page.tsx` passes `disabled={tasks.length === 0}` but no `disabledReason` for this specific button (unlike the Plan Mission button, which already has one). This is a one-line, clearly-beneficial improvement surfaced while transcribing the button (the disabled state was silent before), not a scope change — call this out in the task report so the reviewer evaluates it deliberately rather than flags it as an unreviewed deviation.

- [ ] **Step 7: Modify `page.tsx`** — remove the header block and `ConsoleShell` wrapper, keep everything else

In `apps/web/src/app/(app)/missions/[missionId]/page.tsx`, remove these now-layout-owned imports: `Button` (only used in the header — remove), `ConsoleShell` (moves to layout — remove import, remove the wrapping tag), `MissionStatusBadge` (only used in the header — remove), `LiveRefresh` (only used in the header — remove), `MissionActionButton` (only used in the header — remove the import from `./mission-actions`). **Keep** the `Link` import — the sidebar's "View full Ledger →" and "Retrospective →" links (in the `<aside>` section, not the header) still use it.

Change the component's return from:

```tsx
  return (
    <ConsoleShell>
      {/* Header */}
      <div className="title-glow mb-6 shrink-0">
        ... (entire header block) ...
      </div>

      {/* Top two-thirds: Tasks + Sidebar (own scroll) / bottom third: Timeline console */}
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        ... (unchanged) ...
      </div>
    </ConsoleShell>
  );
```

to:

```tsx
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      ... (unchanged) ...
    </div>
  );
```

Everything inside that div (the tasks grid, sidebar, and the Timeline section below it) is untouched — only the header block above it and the `ConsoleShell` wrapper around it are removed. The `mission`, `tasks`, `taskRollups`, `ledger`, `skill`, `triageSkills`, `targetRepos`, `totalSpentUsd` fetches and computations at the top of the function are all still needed by this remaining content and stay exactly as they are.

- [ ] **Step 8: Run typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS — this also confirms no import was left dangling (unused-but-still-imported doesn't fail typecheck, but a genuinely *missing* import, e.g. if `Link` turned out to still be needed in `page.tsx` and was removed by mistake, would fail here).

- [ ] **Step 9: Run the full test suite**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm -r test`
Expected: PASS — every existing test still green, plus the new 6 `mission-tabs.test.ts` tests.

- [ ] **Step 10: Manual verification (dev server) — required, not optional**

This task has real CSS flex-layout risk (the header/tabs/content split across two files must still fill the viewport correctly) and real behavioral risk (the header conditions must fire identically to before) that no automated test in this plan covers. Run:

```bash
cd apps/web && pnpm dev
```

Open a real mission's detail page (any status) in a browser and confirm:
1. The header (name, status badge, mission id, action buttons appropriate to that mission's status) renders identically to how it looked before this change.
2. The tab bar renders below the header: Overview active/highlighted, Pipeline/Tools/Tasks visibly greyed out and unclickable.
3. The Overview tab's content (goal/budget/sidebar cards, task list, timeline console at the bottom) is unchanged and the page still fills the viewport with no broken scrolling (the timeline console should still be a bottom-anchored, independently-scrollable section, not pushed off-screen or collapsed to zero height).
4. Visit at least one mission in each of `draft`, `planning`, `running`, and `paused` status (or as many as you can find/create) to confirm each status's action buttons still appear exactly as before.

Report the outcome of this manual check in the task report — if anything looks wrong, fix it before marking this task complete; this is not a "nice to have" step.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/mission-tabs.tsx apps/web/src/components/mission-tabs.test.ts apps/web/src/app/\(app\)/missions/\[missionId\]/layout.tsx apps/web/src/app/\(app\)/missions/\[missionId\]/page.tsx
git commit -m "feat(web): add mission detail tab bar shell with Overview tab"
```
