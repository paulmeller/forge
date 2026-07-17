# UI Consistency: shadcn Best Practices + AgentStep Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One visual language across every `(app)` surface: `agentstep-product`'s oklch theme (lime `primary`), standard shadcn components instead of hand-rolled markup, one panel/shell/heading system, shared formatters — per the approved spec `docs/superpowers/specs/2026-07-17-ui-consistency-shadcn-design.md`.

**Architecture:** Foundations first (theme port → component installs → shared primitives → Card/Button rework), then mechanical sweeps (shells/headings → standard components → color semantics + hygiene), then grep-gated verification. Every task leaves the repo typecheck-clean and visually coherent enough to ship.

**Tech Stack:** Tailwind v4 (CSS-first `@theme`), shadcn (new-york/radix), Next.js 15 App Router, vitest.

## Global Constraints

- **Every task's commit must leave the WHOLE monorepo typecheck-clean**: `pnpm typecheck` from repo root before every commit.
- Known pre-existing, unrelated: `pnpm lint` fails repo-wide on `Cannot find package '@eslint/eslintrc'` — do not touch.
- **This is a presentation-layer sweep. No behavioral changes**: routes, data fetching, server actions, and interaction logic stay byte-identical unless a step explicitly says otherwise.
- shadcn skill rules bind every task: semantic tokens only (no raw `emerald-*`/`blue-*`/`amber-*` in app code), `flex gap-*` not `space-*`, `size-*` for equal dims, `truncate`, `cn()` for conditionals, `className` for layout not component styling, icons without size classes.
- Date formatting always passes `'en-US'` (via the shared helper) — locale-default formatting caused a hydration crash before.
- The brand reference is `/Users/paulmeller/Projects/agentstep/agentstep-product/src/app/globals.css` — token values below were transcribed from it and must not be "improved".
- All shadcn CLI commands run from `apps/web` with `npx shadcn@latest …`.

---

### Task 1: Port the agentstep-product theme

**Files:**
- Modify: `apps/web/src/app/globals.css` (full rewrite)
- Modify: `apps/web/tailwind.config.ts`

**Interfaces:**
- Produces: oklch tokens for every existing semantic class (`bg-primary`, `border`, `bg-sidebar-*`, …), plus new tokens `--color-live`, `--color-warning`, `--cta-gradient`, `--font-title`. Consumed by every later task.

- [ ] **Step 1: Rewrite `globals.css`**

Replace the file in full with:

```css
@import 'tailwindcss';

@font-face {
  font-family: 'VVDSFifties';
  src: url('/fonts/VVDSFifties-SExpSBold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@import 'fumadocs-ui/css/neutral.css';
@import 'fumadocs-ui/css/preset.css';

@custom-variant dark (&:is(.dark *));

@config '../../tailwind.config.ts';

@source '../../node_modules/fumadocs-ui/dist/**/*.js';
@source '../**/*.{ts,tsx}';
@source '../../content/**/*.mdx';

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-live: var(--live);
  --color-warning: var(--warning);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --font-sans: var(--font-sans);
  --font-mono: 'Geist Mono', ui-monospace, monospace;
  --font-title: 'VVDSFifties', var(--font-sans);
}

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --live: oklch(0.723 0.192 149.579);
  --warning: oklch(0.769 0.188 70.08);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
  --cta-gradient: none;
  --text-gradient: linear-gradient(135deg, oklch(0.93 0.26 110), oklch(0.9 0.29 132));
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.915 0.275 121);
  --primary-foreground: oklch(0.145 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 6%);
  --input: oklch(1 0 0 / 10%);
  --ring: oklch(0.84 0.24 113);
  --live: oklch(0.723 0.192 149.579);
  --warning: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.84 0.24 113);
  --sidebar-primary-foreground: oklch(0.145 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 6%);
  --sidebar-ring: oklch(0.84 0.24 113);
  --cta-gradient: linear-gradient(135deg, oklch(0.93 0.26 110), oklch(0.9 0.29 132));
  --text-gradient: linear-gradient(135deg, oklch(0.93 0.26 110), oklch(0.9 0.29 132));
}

@layer base {
  * {
    border-color: var(--color-border);
    outline-color: color-mix(in oklch, var(--color-ring) 50%, transparent);
  }
  body {
    background-color: var(--color-background);
    color: var(--color-foreground);
  }
}
```

Deliberate deviations from the product file, all required by Forge's context (record these in your report; they are not errors): Forge keeps its fumadocs imports/`@source` lines and the `@config` bridge; product's `shadcn/tailwind.css`, `tw-animate-css`, chart tokens, glow vars, and marketing-only `@layer components` blocks are omitted; `--destructive-foreground` is ADDED (product's newer components stopped using it, Forge's `new-york` components still do); `--live`/`--warning` are ADDED per the spec (values are Tailwind's emerald-500 and amber-500 in oklch, matching today's rendered colors); the `.accent-checkbox` utility is DELETED (its one consumer keeps working with browser-default accent until Task 7 replaces the native checkboxes).

- [ ] **Step 2: Strip superseded config from `tailwind.config.ts`**

The `@theme` block now owns colors, radius, and fonts. In `apps/web/tailwind.config.ts`, delete the entire `colors` object, the `borderRadius` object, and the `fontFamily` object from `theme.extend` (leaving `container` as the only `extend` key). Keep `darkMode`, `content`, and `plugins` untouched. This removal is what prevents `hsl(var(--border))`-style config colors from wrapping the new oklch values into invalid `hsl(oklch(…))`.

- [ ] **Step 3: Migrate all three `--forge-accent` consumers**

Removing the vars in Step 1 breaks their consumers, so this task updates all three (the `accent` variant's full deletion remains Task 4's job — here it just stops referencing dead vars):

1. `ui/button.tsx` — replace the `accent` variant's classes with the default-primary treatment so existing `variant="accent"` call sites keep compiling until Task 4 removes them:
   ```ts
        accent:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
   ```
2. `apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx` and `issue-run-panel.tsx` — replace `border-[color:var(--forge-accent-to)]` with `border-primary`.
3. Grep gate for this task: `grep -rn "forge-accent" apps/web/src` returns zero hits.

- [ ] **Step 4: Typecheck, test, visual smoke**

Run: `pnpm typecheck` (root) — clean. `pnpm --filter @forge/web test` — all pass.
If a dev server runs on 3100: load `/home` and `/repos` in dark mode; confirm the sidebar "F" mark is now lime, primary buttons are lime, and nothing renders unstyled (a broken token shows as transparent/black).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/tailwind.config.ts apps/web/src/components/ui/button.tsx "apps/web/src/app/(app)/repos/[owner]/[repo]/repo-tabs.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx"
git commit -m "feat(theme): adopt agentstep-product oklch tokens — lime primary, semantic live/warning, CSS-first theme"
```

---

### Task 2: Install the missing shadcn components

**Files:**
- Create (via CLI): `ui/tabs.tsx`, `ui/toggle-group.tsx` (+ its `ui/toggle.tsx` dep), `ui/empty.tsx`, `ui/field.tsx`, `ui/input-group.tsx`, `ui/spinner.tsx`, `ui/checkbox.tsx`, `ui/switch.tsx`, `ui/alert.tsx`
- Possibly modify: `apps/web/package.json`/`pnpm-lock.yaml` (radix deps)

- [ ] **Step 1: Add**

From `apps/web`:

```bash
npx shadcn@latest add tabs toggle-group empty field input-group spinner checkbox switch alert --yes
```

If any prompt asks to overwrite an EXISTING file (`button`, `input`, `label`…), answer NO — only new files may be created. (Registry availability of every named component was verified at plan time.)

- [ ] **Step 2: Review added files per the shadcn skill workflow**

Read each added file. Fix, if present: import-alias mismatches, missing sub-components, icon imports not from `lucide-react`. Then check the Tailwind v4 compatibility bug this repo already hit once: `grep -n 'w-\[--' src/components/ui/*.tsx` and `grep -n '\[--[a-z-]*\]' src/components/ui/tabs.tsx src/components/ui/toggle*.tsx src/components/ui/empty.tsx src/components/ui/field.tsx src/components/ui/input-group.tsx src/components/ui/spinner.tsx src/components/ui/checkbox.tsx src/components/ui/switch.tsx src/components/ui/alert.tsx` — any bare `[--var]` arbitrary value must be wrapped as `[var(--var)]`.

- [ ] **Step 3: Typecheck + commit**

`pnpm typecheck` (root) clean, then:

```bash
git add apps/web/src/components/ui apps/web/package.json pnpm-lock.yaml
git commit -m "feat(ui): add tabs, toggle-group, empty, field, input-group, spinner, checkbox, switch, alert"
```

---

### Task 3: Shared formatters + PrChip (TDD for formatters)

**Files:**
- Create: `apps/web/src/lib/format.ts`, `apps/web/src/lib/format.test.ts`, `apps/web/src/components/pr-chip.tsx`
- Modify (migrate call sites): `components/progress-pill.tsx`, `components/queue-section.tsx`, `components/repo-budget-line.tsx`, `components/missions-table.tsx`, `app/(app)/repos/[owner]/[repo]/issue-run-panel.tsx`, `app/(app)/repos/[owner]/[repo]/attempt-file-browser.tsx`, `app/(app)/missions/[missionId]/tasks/[taskId]/page.tsx`, `app/(app)/missions/[missionId]/ledger/page.tsx` (if it formats dates — check), any other `Intl.DateTimeFormat`/`formatRelative`/USD-format sites found by grep.

**Interfaces:**
- Produces:
  ```ts
  export function formatDateTime(date: Date, opts?: { seconds?: boolean }): string; // 'en-US', "Jul 17, 9:43 PM" / with seconds
  export function formatRelative(date: Date, nowMs?: number): string; // "42s ago" | "5m ago" | "3h ago" | "2d ago"; nowMs defaults to Date.now(), injectable for tests
  export function formatUsd(n: number): string;       // "$0" | "$0.19" | "$12" | "$12.34"
  export function formatTokens(n: number): string;    // "512" | "36.6k" | "1.32M"
  export function PrChip({ prUrl, prNumber, status }: { prUrl: string; prNumber: number | null; status?: string }): JSX.Element; // Badge variant="outline", ↗ external
  ```

- [ ] **Step 1: Write failing tests** — `format.test.ts` with cases pinned to today's rendered outputs so migration is behavior-preserving: `formatDateTime(new Date('2026-07-17T09:43:00'))` → `"Jul 17, 9:43 PM"`; seconds variant; `formatRelative` at 42s/5m/3h/2d offsets (inject `now` as an optional second arg for testability); `formatUsd(0)==='$0'`, `(0.19)==='$0.19'`, `(12)==='$12'`, `(12.34)==='$12.34'`; `formatTokens(512)==='512'`, `(36600)==='36.6k'`, `(1318999)==='1.32M'`. Run, confirm FAIL (module missing).

- [ ] **Step 2: Implement `format.ts`** — consolidate the existing implementations (copy the arithmetic from `progress-pill.tsx`'s `formatRelative`/`formatTokens`/`formatUsd` and the `'en-US'` `DateTimeFormat` options already used in `issue-run-panel.tsx`; do not invent new formats). Run tests → PASS.

- [ ] **Step 3: `PrChip`** — Badge-based, replacing both hand-rolled blue chips:

```tsx
import { Badge } from '@/components/ui/badge';

export function PrChip({ prUrl, prNumber, status }: { prUrl: string; prNumber: number | null; status?: string }) {
  return (
    <Badge variant="outline" asChild>
      <a href={prUrl} target="_blank" rel="noreferrer">
        PR #{prNumber}
        {status ? ` · ${status}` : ''} ↗
      </a>
    </Badge>
  );
}
```

(If the installed `badge.tsx` lacks `asChild`, wrap the `<a>` around `<Badge>` instead — check the actual file.)

- [ ] **Step 4: Migrate every call site.** Find them all: `grep -rn "DateTimeFormat\|formatRelative\|formatUsd\|formatTokens\|toFixed(2)\|border-blue-500" apps/web/src --include="*.tsx" --include="*.ts" -l` (excluding `ui/` and `lib/format.ts`). Replace local implementations with imports from `@/lib/format`; both PR chips (queue-section, issue-run-panel) become `<PrChip …/>`. Delete the now-dead local helpers. Server components (missions-table, task detail, ledger) switch from locale-`undefined` to `formatDateTime` — this intentionally changes their rendered format to the en-US convention (spec-mandated unification).

- [ ] **Step 5: Gates + commit** — `grep -rn "Intl.DateTimeFormat" apps/web/src --include="*.tsx" | grep -v "lib/format.ts"` → zero. `grep -rn "border-blue-500" apps/web/src` → zero. `pnpm typecheck` clean; `pnpm --filter @forge/web test` all pass.

```bash
git add -A apps/web/src && git commit -m "feat(ui): shared format helpers + Badge-based PrChip, all call sites migrated"
```

---

### Task 4: Card as THE panel + Button accent removal

**Files:**
- Modify: `apps/web/src/components/ui/card.tsx`, `apps/web/src/components/ui/button.tsx`
- Modify (accent call sites): `app/(app)/missions/new/new-mission-form.tsx`, `app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx`, `app/(app)/repos/[owner]/[repo]/settings-tab.tsx`

- [ ] **Step 1: Restyle Card flat.** In `ui/card.tsx`: `Card` root classes become `"rounded-lg border bg-card text-card-foreground"` (drop `rounded-xl` and `shadow`); `CardHeader` becomes `"flex flex-col gap-1.5 px-4 py-3"`; `CardContent` becomes `"px-4 pb-4"`; `CardFooter` becomes `"flex items-center px-4 pb-4"`. `CardTitle`/`CardDescription` unchanged.
- [ ] **Step 2: Delete the `accent` variant** from `ui/button.tsx` (the whole `accent:` line) and change the three call sites' `variant="accent"` to no variant prop (default = primary = lime in dark).
- [ ] **Step 3: Gates + commit** — `grep -rn 'variant="accent"' apps/web/src` → zero; `pnpm typecheck` clean; tests pass; visual smoke of `/missions/[id]` + `/missions/new` if server running.

```bash
git add apps/web/src && git commit -m "feat(ui): flat Card as the single panel language; accent variant retired for primary"
```

---

### Task 5: Shells + headings

**Files:**
- Create: `apps/web/src/components/page-shell.tsx`, `apps/web/src/components/console-shell.tsx`
- Modify: every `(app)` page listed in the spec's sweep scope.

- [ ] **Step 1: Shell components**

```tsx
// page-shell.tsx — centered document pages
import { cn } from '@/lib/utils';

export function PageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn('container max-w-[1400px] py-8', className)}>{children}</main>;
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-title text-3xl uppercase tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-start gap-2">{actions}</div> : null}
    </div>
  );
}
```

```tsx
// console-shell.tsx — full-bleed fixed-height IDE pages
import { cn } from '@/lib/utils';

export function ConsoleShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn('flex h-full flex-col overflow-hidden px-6 py-4', className)}>{children}</main>;
}
```

- [ ] **Step 2: Apply per page.** Document pages (home, missions, missions/new, repos, ledger, plan, issues, retrospective, task detail, chat, setup): replace the `<main className="container …">` wrapper with `<PageShell>` and the ad-hoc h1 block with `<PageHeader …>` (mission/task detail pages keep their status badges/actions via the `actions`/`title` slots — e.g. `title={mission.name}` with the badge inside `actions` or beside the title inside a flex in `title`). Console pages (repo console, mission detail): swap `<main className="flex h-full …">` for `<ConsoleShell>`; their h1s also become `font-title text-3xl uppercase` inline (they have custom header rows, not `PageHeader`). Auth pages untouched. Every page keeps its existing content markup otherwise.
- [ ] **Step 3: Gates + commit** — `grep -rn '<main className="container' "apps/web/src/app/(app)"` → only login/signup remain; `grep -rn 'text-2xl font-semibold tracking-tight">' "apps/web/src/app/(app)" --include=page.tsx` → zero h1 hits; `pnpm typecheck` clean; tests pass.

```bash
git add apps/web/src && git commit -m "feat(ui): PageShell/ConsoleShell + font-title headings across every app page"
```

---

### Task 6: Standard components A — Tabs and ToggleGroup

**Files:**
- Modify: `repo-tabs.tsx`, `issue-run-panel.tsx`, `mission-filters.tsx`

- [ ] **Step 1: `RepoTabs` → shadcn `Tabs`.** URL-driven: render `<Tabs value={active}>` with `<TabsList>` and three `<TabsTrigger value=… asChild><Link href=…>` children so navigation stays link-based (hrefs unchanged: bare path for issues, `?tab=` for the others). Delete the hand-rolled underline classes; the active state comes from `value`.
- [ ] **Step 2: `IssueRunPanel` attempt + stage rows → `Tabs`.** Two controlled `<Tabs>` (`value={String(attemptIndex)} onValueChange={(v) => setAttemptIndex(Number(v))}` and `value={effectiveStage} onValueChange={(v) => setStage(v as 'reproduce' | 'fix')}`). `TabsTrigger` content keeps the existing labels/badges (status badge inside the trigger is allowed). The `●` newest marker and gating logic (`effectiveStage`, hidden attempt row when only 1 attempt) are preserved exactly.
- [ ] **Step 3: `MissionFilters` pills → `ToggleGroup`.** Statuses: `type="multiple"` with `value={activeStatuses}` and `onValueChange` writing the comma-joined `status` param. Backend and kind: `type="single"` (kind's `'all'` maps to empty param exactly as today; `onValueChange` receives `''` when deselecting — preserve current URL semantics precisely). Search input and Clear button unchanged. Delete the hand-rolled pill markup.
- [ ] **Step 4: Gates + commit** — behavior check in browser if server running (tab nav, filters round-trip the URL); `pnpm typecheck` clean; tests pass.

```bash
git add apps/web/src && git commit -m "feat(ui): shadcn Tabs for repo/run tabs, ToggleGroup for mission filters"
```

---

### Task 7: Standard components B — Empty, Field/InputGroup, Spinner, Checkbox

**Files:**
- Modify: every dashed empty-state site (`grep -rn "border-dashed" apps/web/src --include="*.tsx"` — queue empties are plain text and stay), `settings-tab.tsx`, `steer-input.tsx`, pending-label buttons (`repo-toolbar.tsx`, `settings-tab.tsx`, `steer-input.tsx`, `work-on-it-button.tsx`, `mission-actions.tsx`, `new-issue-dialog.tsx` — grep `'…'` pending labels).

- [ ] **Step 1: Empty states** → `Empty` composition (`EmptyHeader`/`EmptyTitle`/`EmptyDescription`, plus the action link where one exists, e.g. "Connect repos in Setup"). Keep copy verbatim.
- [ ] **Step 2: `settings-tab.tsx`** → `FieldGroup`/`Field`/`FieldLabel`/`FieldDescription` for the two number inputs; native checkboxes → `Checkbox` with `FieldLabel`; validation errors surface via `FieldDescription` + `data-invalid`/`aria-invalid` per the skill's forms rules. Same state logic, same `updateRepoSettings` call.
- [ ] **Step 3: `steer-input.tsx`** → `InputGroup` + `InputGroupInput` + `InputGroupAddon` (Send button inside the addon). Same submit/pending/error behavior; error text becomes the field-level error line.
- [ ] **Step 4: Pending buttons** → `<Spinner data-icon="inline-start" />` + original label + `disabled` (replacing the "Saving…"-style text swaps).
- [ ] **Step 5: Gates + commit** — `grep -rn "border-dashed" "apps/web/src/app/(app)"` → zero; `grep -rn "accent-checkbox\|type=\"checkbox\"" apps/web/src --include="*.tsx"` → zero outside `ui/`; typecheck + tests.

```bash
git add apps/web/src && git commit -m "feat(ui): Empty states, Field/InputGroup forms, Spinner pending buttons, real Checkboxes"
```

---

### Task 8: Color semantics + class hygiene sweep

**Files:** everything remaining with raw palette classes or banned utilities (grep-driven).

- [ ] **Step 1: Live indicators** — `live-refresh.tsx`, `workspace-list.tsx`, `queue-section.tsx`, `role-tagged-event.tsx`, `progress-pill.tsx`: every `emerald-*` class becomes the `live` token (`bg-live`, `text-live`, `bg-live/30` etc. — match today's rendered look; `LiveRefresh`'s pill uses `bg-live/15 text-live` in light-safe form).
- [ ] **Step 2: Budget tones** — `repo-budget-line.tsx`, `budget-gauge.tsx`: `amber-500` → `warning` token; normal bar `bg-primary`; over `bg-destructive`.
- [ ] **Step 3: Remaining raw colors** — `retrospective/proposal-card.tsx` emerald, the connect-repos banner's `yellow-600/40 yellow-950/20` (→ `Alert` with `warning`-token styling via semantic classes), and anything else `grep -rn "emerald-\|amber-\|blue-\d\|yellow-" apps/web/src --include="*.tsx"` finds outside `ui/`.
- [ ] **Step 4: Hygiene** — across `apps/web/src` app code (not `ui/`): `space-y-*`/`space-x-*` → `flex flex-col gap-*`/`gap-*`; equal `w-N h-N` → `size-N`; template-literal class ternaries → `cn()`; `decoration-dotted` link styles → the standard solid-underline or arrow conventions (`→` internal / `↗` external, trailing).
- [ ] **Step 5: Gates + commit** — all spec grep gates return zero in `apps/web/src` excluding `ui/`: `forge-accent`, `emerald-`, `blue-500`, `space-y-`, `space-x-`, `DateTimeFormat(undefined`, `decoration-dotted`. Typecheck + tests.

```bash
git add apps/web/src && git commit -m "feat(ui): semantic live/warning tokens, hygiene sweep (gap, size, cn, link conventions)"
```

---

### Task 9: Full verification

**Files:** none.

- [ ] **Step 1:** `pnpm typecheck && pnpm test` from root — clean, all suites.
- [ ] **Step 2:** Re-run every grep gate from Tasks 1, 3, 4, 5, 7, 8 — all zero.
- [ ] **Step 3: Browser walkthrough, dark AND light** (toggle via the user menu): home, missions, composer, mission detail, task detail, ledger, plan, retrospective, repos, repo console (all three tabs, with a selected issue), chat, setup. Confirm: lime primary CTAs and sidebar mark; one heading style; one panel style; tabs/toggles/empties/fields render correctly; dates one format; no hydration warnings in console; no unstyled/transparent regions.
- [ ] **Step 4:** Report pass/fail per check; defer to the operator anything the environment can't verify.
