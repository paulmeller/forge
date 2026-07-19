# Repo Console Toolbar Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the repo console header's 7-button action cluster down to 2 inline buttons + 1 overflow menu, per `docs/superpowers/specs/2026-07-18-repo-toolbar-overflow-design.md`, fixing the title-truncation squeeze found during UI polish verification.

**Architecture:** `RepoToolbar` gains a `missionsHref` prop and a `DropdownMenu` (already-installed shadcn primitive) replacing 5 of its 6 rendered actions; the parent page stops rendering the standalone "View missions" link and threads the href down instead. No new components, no new dependencies, no business-logic changes — pending/error state and handlers are reused as-is.

**Tech Stack:** Next.js App Router, shadcn/ui `dropdown-menu` (already installed, used in `nav-user.tsx`), `lucide-react` (already a dependency).

## Global Constraints

- Every commit leaves the whole monorepo `pnpm typecheck` clean (all 4 projects `Done`).
- Do NOT run `pnpm lint` (pre-existing repo-wide breakage — out of scope, never re-flag).
- No new dependencies. No changes to `NewIssueDialog`, `Run a goal` button, or any other repo-console file besides the two named below.
- Behavior preservation: `handleToggleActive`, `handleManualTick`, `router.refresh()`, and the external GitHub link (`target="_blank" rel="noreferrer"`) must work identically to today, just triggered from menu items.
- Line numbers below were captured at plan-writing time and may drift a few lines — match on the quoted old strings, which are unique in each file.

---

### Task 1: RepoToolbar overflow menu + page.tsx prop threading

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx` (full rewrite of the render + prop signature)
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx` (remove standalone "View missions" link, pass `missionsHref`)

**Interfaces:**
- Produces: `RepoToolbar({ repo, containerStatus, missionsHref })` — `missionsHref: string | null` is new; `repo`/`containerStatus` unchanged.
- Consumes: `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` from `@/components/ui/dropdown-menu` (already installed); `MoreHorizontal` from `lucide-react`.

- [ ] **Step 1: Rewrite `repo-toolbar.tsx`** — replace the entire file contents with:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { activateRepo, deactivateRepo, triggerManualTick } from './actions';

export function RepoToolbar({
  repo,
  containerStatus,
  missionsHref,
}: {
  repo: string;
  containerStatus: 'running' | 'paused' | null;
  missionsHref: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggleActive() {
    setError(null);
    startTransition(async () => {
      const result =
        containerStatus === 'paused' ? await activateRepo(repo) : await deactivateRepo(repo);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleManualTick() {
    setError(null);
    startTransition(async () => {
      const result = await triggerManualTick();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex shrink-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 px-0" disabled={pending}>
              <MoreHorizontal className="size-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {missionsHref ? (
              <DropdownMenuItem asChild>
                <Link href={missionsHref}>View missions</Link>
              </DropdownMenuItem>
            ) : null}
            {containerStatus ? (
              <DropdownMenuItem onClick={handleToggleActive} disabled={pending}>
                {containerStatus === 'paused' ? 'Activate' : 'Deactivate'}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={handleManualTick} disabled={pending}>
              Manual
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.refresh()}>Refresh</DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
                GitHub ↗
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild size="sm">
          <Link href={`/missions/new?repo=${encodeURIComponent(repo)}`}>Run a goal on this repo →</Link>
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
```

(The overflow trigger renders first/left of `Run a goal` so the primary CTA stays the rightmost, most-emphasized element — matching the original visual weighting where `Run a goal` was last.)

- [ ] **Step 2: Update `page.tsx`** — remove the standalone "View missions" link and pass the href to `RepoToolbar` instead. Replace:

```tsx
          <div className="flex shrink-0 items-start gap-2">
            <NewIssueDialog owner={owner} repo={repoName} />
            {mission ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/missions?repo=${encodeURIComponent(repo)}`}>View missions</Link>
              </Button>
            ) : null}
            <RepoToolbar
              repo={repo}
              containerStatus={
                mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
              }
            />
          </div>
```

with:

```tsx
          <div className="flex shrink-0 items-start gap-2">
            <NewIssueDialog owner={owner} repo={repoName} />
            <RepoToolbar
              repo={repo}
              containerStatus={
                mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
              }
              missionsHref={mission ? `/missions?repo=${encodeURIComponent(repo)}` : null}
            />
          </div>
```

- [ ] **Step 3: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: all 4 projects `Done`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(repo-console): collapse 5 secondary toolbar actions into an overflow menu"
```

---

### Task 2: Verification (controller-run)

- [ ] **Step 1: Automated** — from repo root: `pnpm typecheck`. Expected: 4/4 Done.

- [ ] **Step 2: Browser walkthrough** (dev server on :3100, dark AND light):
  - Repo console for a long-named repo (e.g. `paulmeller/forge-sandbox`) — confirm the repo name no longer truncates to `paulmeller…` at the narrow two-column layout width; measure the title's rendered width vs. before (~163px) to confirm real improvement.
  - Click the "more actions" trigger — dropdown opens with `View missions` (if a mission exists), `Deactivate`/`Activate`, `Manual`, `Refresh`, `GitHub ↗` in that order.
  - Exercise `Refresh` and (if safe/no side effects on real data) `View missions`/`GitHub ↗` links — confirm correct navigation/behavior.
  - Confirm `Run a goal on this repo →` still renders as the emphasized inline button.
  - Console: no errors or hydration warnings.

- [ ] **Step 3: Ledger entry** in `.superpowers/sdd/progress.md`; fix anything found first.

---

## Self-Review Notes

- Spec coverage: the spec's single design (prop threading + dropdown collapse) maps 1:1 to Task 1's two steps.
- Type consistency: `missionsHref: string | null` matches its call site in `page.tsx` exactly (`mission ? ... : null`).
- Placeholder scan: both file rewrites are complete, exact code — no TBDs.
