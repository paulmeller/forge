# UI Fast-Follows: Panel Unification + NavTabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the two approved fast-follows from the UI-consistency final review: (1) replace the Radix Tabs misuse on the repo console with real navigation links styled as tabs, and (2) complete spec §3 "Card is THE panel" by migrating the remaining hand-rolled `rounded-lg border` panels to the Card component (or giving row-level bordered items the `bg-card` fill).

**Architecture:** One new presentational component (`NavTabs`, server-compatible — plain `next/link` anchors styled with the existing TabsList/TabsTrigger classes) replaces the Radix `Tabs` in `repo-tabs.tsx`, restoring native ctrl/cmd/middle-click open-in-new-tab and correct nav semantics. Panel migration swaps wrapper `div`s for `Card`/`CardHeader`/`CardContent`; interactive row-level items (link rows, option cards, plan rows) keep their element type and just gain `bg-card text-card-foreground`, because in dark mode `--card` (0.205) differs from `--background` (0.145) and mixed fills are visible.

**Tech Stack:** Next.js App Router, Tailwind v4 CSS-first tokens, shadcn/ui new-york (radix base).

## Global Constraints

- Every commit leaves the whole monorepo `pnpm typecheck` clean (all 4 projects). Run it from the repo root before each commit.
- Do NOT run `pnpm lint` (pre-existing repo-wide breakage on `@eslint/eslintrc` — out of scope, never re-flag).
- Semantic tokens only — never raw palette classes (`emerald-`, `blue-500`, `amber-`, `yellow-`, etc.).
- No `space-y-*`/`space-x-*`; use `flex` + `gap-*`. Tailwind v4: arbitrary CSS-variable values must be `[var(--x)]`, never bare `[--x]`.
- Behavior preservation: all hrefs, query params, form submissions, and server-action calls stay byte-identical. The ONLY intended behavior change in this plan is that repo-console tab clicks become real link navigations (ctrl/cmd/middle-click now open new tabs — this is the point).
- `apps/web` tests are node-environment vitest only (no jsdom); these presentational tasks are verified by typecheck + the Task 3 browser walkthrough, not component tests.
- Web dev server runs on http://localhost:3100 (already running; user is authenticated in Chrome).

---

### Task 1: NavTabs component + repo-tabs migration

**Files:**
- Create: `apps/web/src/components/nav-tabs.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx` (full rewrite, 35 lines)

**Interfaces:**
- Produces: `NavTabs({ items, activeKey, className })` where `items: Array<{ key: string; label: string; href: string }>` — a `<nav>` of `next/link` anchors visually identical to shadcn `TabsList`/`TabsTrigger`.
- Consumes: `cn()` from `@/lib/utils`; class strings copied from `apps/web/src/components/ui/tabs.tsx` (TabsList line 17, TabsTrigger line 32).

- [ ] **Step 1: Create `apps/web/src/components/nav-tabs.tsx`** with exactly:

```tsx
import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Navigation links styled as shadcn Tabs. Use this (not Radix Tabs) when the
 * "tabs" are URL navigation: real anchors keep native ctrl/cmd/middle-click
 * open-in-new-tab and correct semantics (Radix TabsTrigger preventDefaults
 * mousedown with modifiers).
 */
export function NavTabs({
  items,
  activeKey,
  className,
}: {
  items: ReadonlyArray<{ key: string; label: string; href: string }>;
  activeKey: string;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
    >
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.key === activeKey ? 'page' : undefined}
          className={cn(
            'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            item.key === activeKey && 'bg-background text-foreground shadow',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Rewrite `repo-tabs.tsx`** — replace the entire file contents with:

```tsx
import { NavTabs } from '@/components/nav-tabs';

const TABS = [
  { key: 'issues', label: 'Issues' },
  { key: 'activity', label: 'Activity' },
  { key: 'settings', label: 'Settings' },
] as const;

export function RepoTabs({
  active,
  repo,
}: {
  active: 'issues' | 'activity' | 'settings';
  repo: string;
}) {
  return (
    <NavTabs
      className="mb-4"
      activeKey={active}
      items={TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        href: tab.key === 'issues' ? `/repos/${repo}` : `/repos/${repo}?tab=${tab.key}`,
      }))}
    />
  );
}
```

Notes: the `'use client'` directive is deliberately dropped (both files are server-compatible), and hrefs are byte-identical to the old ones (bare path for issues, `?tab=` for the rest).

- [ ] **Step 3: Verify no other consumer relied on repo-tabs being a Radix Tabs**

Run: `grep -rn "RepoTabs" apps/web/src --include="*.tsx"`
Expected: only the definition and its usage in `app/(app)/repos/[owner]/[repo]/page.tsx` (render-site props unchanged: `active`, `repo`).

- [ ] **Step 4: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: all 4 projects `Done`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/nav-tabs.tsx "apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx"
git commit -m "feat(ui): NavTabs nav-links-styled-as-tabs; repo console tabs are real links again"
```

---

### Task 2: Panel unification — Card everywhere a panel is drawn

**Files:**
- Modify: `apps/web/src/app/(app)/home/page.tsx:73-90` (metric tiles)
- Modify: `apps/web/src/components/queue-section.tsx:42-47` (section wrapper)
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx:50-51,110` (form wrapper)
- Modify: `apps/web/src/components/missions-table.tsx:35,48` (table wrapper + empty)
- Modify: `apps/web/src/components/timeline.tsx:76` (event group section)
- Modify: `apps/web/src/app/(app)/repos/page.tsx:39` (repo link rows — fill only)
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/workspace-list.tsx:166` (issue-list panel — fill only)
- Modify: `apps/web/src/app/(app)/missions/[missionId]/plan/plan-editor.tsx:124` (plan rows — fill only)
- Modify: `apps/web/src/app/(app)/missions/new/new-mission-form.tsx:136` (mission-type option cards — fill only)

**Interfaces:**
- Consumes: `Card`, `CardHeader`, `CardTitle`, `CardContent` from `@/components/ui/card` (Card root classes: `rounded-lg border bg-card text-card-foreground`).
- Produces: no API changes — every component keeps its existing props.

Deliberately NOT touched (each has a reason a reviewer should honor): `timeline-client.tsx:38` scroll box (`bg-muted/20` is the intentional console-well treatment), `chat-interface.tsx:231` (floating popover, `bg-background shadow-lg` is popover language), `repos/[owner]/[repo]/page.tsx:73` error box (destructive-tinted alert treatment).

- [ ] **Step 1: Home metric tiles** — in `app/(app)/home/page.tsx`, add `Card` to the existing `@/components/ui/card` import line if absent (the file currently imports only Alert/Button/etc.; add `import { Card } from '@/components/ui/card';`), then replace each of the four tiles:

```tsx
<div className="rounded-lg border px-4 py-3">
```

with

```tsx
<Card className="px-4 py-3">
```

and each matching closing `</div>` of those four tiles with `</Card>`. (Four occurrences, lines 74/78/82/86; content inside unchanged.)

- [ ] **Step 2: QueueSection wrapper** — in `components/queue-section.tsx`, add:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
```

and replace the wrapper (lines 42-47 and the matching closes):

```tsx
    <div className="rounded-lg border">
      <p className="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="p-2">
```

with

```tsx
    <Card>
      <CardHeader className="border-b px-3 py-2">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2">
```

and the two closing tags at the end of the component from `</div></div>` to `</CardContent></Card>`.

- [ ] **Step 3: SettingsTab wrapper** — in `settings-tab.tsx`, add `import { Card, CardContent } from '@/components/ui/card';`, then replace line 51:

```tsx
    <div className="max-w-md rounded-lg border p-6">
```

with

```tsx
    <Card className="max-w-md">
      <CardContent className="p-6">
```

and the final `</div>` (line 110) with `</CardContent></Card>`.

- [ ] **Step 4: MissionsTable** — in `components/missions-table.tsx`, add `import { Card } from '@/components/ui/card';`, then:
  - Line 35: `className={bare ? undefined : 'border'}` → `className={bare ? undefined : 'border bg-card'}` (Empty state gets the card fill too).
  - Line 48: extract the existing `<Table>…</Table>` JSX (lines 49-100, unchanged) into a `const table = (…)` above the return, then replace the old wrapper with a conditional element — bare mode MUST stay a plain passthrough div, not a de-styled Card:

```tsx
  const table = (
    <Table className="min-w-[1000px]">
      ...existing table contents, byte-identical...
    </Table>
  );
  return bare ? <div>{table}</div> : <Card>{table}</Card>;
```

- [ ] **Step 5: Timeline event groups** — in `components/timeline.tsx`, add `import { Card } from './ui/card';`, then replace line 76:

```tsx
          <section key={taskId ?? '_mission'} className="rounded-lg border bg-card">
```

with

```tsx
          <Card key={taskId ?? '_mission'}>
```

and change the matching `</section>` to `</Card>`. (`Card` has no `asChild` prop — it renders a plain div, which is fine; the `section` element carried no behavior.)

- [ ] **Step 6: Row-level fills (bg-card only, element types unchanged):**
  - `app/(app)/repos/page.tsx:39`: `'block rounded-lg border p-4 font-mono text-sm transition-colors hover:bg-accent'` → `'block rounded-lg border bg-card p-4 font-mono text-sm transition-colors hover:bg-accent'`
  - `workspace-list.tsx:166`: `"flex h-full min-h-0 flex-col rounded-lg border"` → `"flex h-full min-h-0 flex-col rounded-lg border bg-card"`
  - `plan-editor.tsx:124`: `className="rounded-lg border p-3"` → `className="rounded-lg border bg-card p-3"`
  - `new-mission-form.tsx:136`: `'relative rounded-lg border p-3 text-left transition-colors',` → `'relative rounded-lg border bg-card p-3 text-left transition-colors',`

- [ ] **Step 7: Typecheck**

Run from repo root: `pnpm typecheck`
Expected: all 4 projects `Done`.

- [ ] **Step 8: Commit**

```bash
git add -A apps/web/src
git commit -m "refactor(ui): Card is THE panel — migrate remaining flat divs to Card / bg-card fills"
```

---

### Task 3: Verification sweep

**Files:**
- No new files. Read-only checks + browser walkthrough.

- [ ] **Step 1: Automated gates**

Run from repo root:

```bash
pnpm typecheck && pnpm --filter web test
```

Expected: 4/4 typecheck `Done`; 19 files / 171 tests pass (no web test touches these components).

- [ ] **Step 2: Panel grep gate** — every remaining `rounded-lg border` outside `src/components/ui/` must either include `bg-card` or be on the documented exception list (timeline-client console well `bg-muted/20`, chat-interface popover `bg-background`, repo page destructive error box):

```bash
cd apps/web/src && grep -rn "rounded-lg border" --include="*.tsx" . | grep -v components/ui/ | grep -v "bg-card" | grep -v "bg-muted/20" | grep -v "bg-background" | grep -v "border-destructive"
```

Expected: empty output.

- [ ] **Step 3: Radix-Tabs-for-nav gate** — `TabsTrigger asChild` must no longer appear outside genuinely stateful tab groups:

```bash
cd apps/web/src && grep -rn "TabsTrigger" --include="*.tsx" . | grep -v components/ui/
```

Expected: matches only in `issue-run-panel.tsx` (attempt/stage rows — stateful, correct) and `tasks/[taskId]/page.tsx` run-file viewer if present; NONE in `repo-tabs.tsx`.

- [ ] **Step 4: Browser walkthrough** (dev server on :3100, dark AND light via the user-menu Toggle theme):
  - `/home` — metric tiles and all three queue sections show the card fill (visibly lighter than the page background in dark mode); rows still navigate.
  - `/missions` — table wrapper has card fill; row click still opens the mission.
  - `/repos` — repo rows have card fill; hover still shows accent.
  - `/repos/paulmeller/forge-sandbox` — tab strip looks identical to before; plain click switches tabs; **cmd-click (mac) on "Activity" opens a new tab** (the fix this plan exists for); Settings tab shows the Card-wrapped form; issue list panel has card fill.
  - A mission detail page — timeline event groups unchanged visually (they already had bg-card).
  - `/missions/new` — mission-type option cards have card fill; selection ring still renders.
  - Console: no errors or hydration warnings.

- [ ] **Step 5: Commit any fixes found, then final ledger entry** in `.superpowers/sdd/progress.md`.

---

## Self-Review Notes

- Spec coverage: review fast-follow #2 (nav tabs) → Task 1; spec §3 / review Minor #5 (panel unification) → Task 2; both verified → Task 3. The other review minors (USD locale pins, PageHeader min-w-0, `--live` role drift, Alert role) are explicitly NOT in this plan — they were triaged as separate items and are not part of what the user approved here.
- Type consistency: `NavTabs` props defined in Task 1 match the Task 1 Step 2 call site exactly. Card imports named per file in Task 2.
- Placeholder scan: all steps carry exact code or exact old→new strings; the two deliberate "don't do X, do Y" callouts in Task 2 Steps 4-5 are instructions, not placeholders.
