# UI Consistency: shadcn Best Practices + AgentStep Theme — Design

Date: 2026-07-17
Status: approved (brainstorm complete)
Scope: one contract + one full sweep of every `(app)` surface

## Context: the audit

The console grew by accretion and now runs several visual languages at once:

- **11 distinct `<main>` shells** across three models (centered containers at
  seven different max-widths; two full-bleed IDE pages; auth centering).
- **Two heading languages**: `font-title` uppercase (Home, composer,
  marketing) vs `text-2xl font-semibold` (eight pages) vs mono (task detail).
- **Two panel languages**: shadcn `Card` (mission detail, task detail, plan,
  retrospective, auth) vs flat `rounded-lg border` panels (home queue, repo
  console, missions table, settings).
- **Four accents fighting**: lime (3 places), black/white primary buttons,
  stock-shadcn blue (`--sidebar-primary` — the sidebar "F" mark), and
  blue-500 PR chips; emerald marks live activity in 6 files.
- **Visibly inconsistent dates**: `Intl.DateTimeFormat(undefined, …)` in
  server components vs `'en-US'` in client components — two formats for the
  same timestamp on adjacent pages (and the locale-default pattern already
  caused one hydration crash).
- **Duplicated drifting primitives**: `formatRelative` ×2, PR-chip styles
  ×2, USD formatting ×3, date formatting ×4; link affordances vary
  (`→` / none / `↗` / dotted vs solid underline).

## The contract

### 1. Theme: adopt `agentstep-product`'s tokens wholesale

`/Users/paulmeller/Projects/agentstep/agentstep-product/src/app/globals.css`
is the brand source of truth. Forge's `globals.css` adopts its token system:

- Replace Forge's hsl `:root`/`.dark` blocks and the CLI-appended hsl
  sidebar block with product's **oklch** token set verbatim: neutral light
  mode; dark mode `--primary: oklch(0.915 0.275 121)` (lime) with dark ink
  foreground, lime `--ring`, lime `--sidebar-primary` (this alone fixes the
  blue "F" mark), white-alpha borders, `--cta-gradient`, `--glow-sm/lg`,
  and the derived radius scale.
- Add product's `@theme inline` mapping (`--color-* → var(--*)`, radius
  scale, `--font-title`/`--font-heading` = VVDSFifties, `--font-mono` =
  Geist Mono). The woff2 already exists in Forge's `public/fonts/`.
- Keep Forge's fumadocs imports/`@source` lines and the `@config`
  bridge only if still required; migrate `tailwind.config.ts` color
  definitions to the CSS-first tokens so `bg-primary` etc. resolve from the
  new set. Delete `--forge-accent-*` after migrating its consumers (button
  `accent` variant, RepoTabs/attempt-tab underline, `.accent-checkbox`).
- Forge keeps its `new-york`/radix component base — we adopt product's
  *theme CSS*, not its `base-nova` component style.

### 2. Semantic color rules (no raw palette classes in app code)

- `primary` = the interaction color (lime in dark, ink in light). All
  primary CTAs are plain `<Button>` (default variant). The custom
  `variant="accent"` gradient is deleted; the lime gradient
  (`--cta-gradient`) is reserved for marketing/hero use.
- Active tab indicators, selection rings, focus rings: `primary`/`ring`
  tokens — never `var(--forge-accent-to)` literals.
- **Live/running** gets one semantic token: `--live` (the current emerald),
  declared in `@theme` as `--color-live`, used by the pulsing dots and
  `LiveRefresh`. No `emerald-*` literals in components.
- PR chips, cost chips, "Issue" markers: `Badge` variants (`outline`,
  `secondary`) — the `border-blue-500/40` styling is deleted.
- Budget bar tones: `bg-primary` normal, `bg-destructive` over; the warn
  tier uses `--warning` (amber) declared once in `@theme`.
- `destructive` only for destructive actions/states.

### 3. Standard components over hand-rolled markup

- `RepoTabs` and `IssueRunPanel`'s attempt/stage tab rows → shadcn `Tabs`
  (`TabsList`/`TabsTrigger`; RepoTabs keeps URL-driven navigation by
  rendering `TabsTrigger` with `asChild` links).
- `MissionFilters`' hand-rolled pills (status multi-select, backend, kind)
  → `ToggleGroup` (`type="multiple"` for statuses, `type="single"` for
  backend/kind).
- Dashed-border empty states → `Empty` composition.
- `settings-tab.tsx` and `SteerInput` forms → `Field`/`FieldGroup` +
  `InputGroup` composition per the skill's forms rules; native checkboxes
  in settings → `Checkbox`/`Switch`.
- Pending buttons ("Saving…", "Sending…", "Aborting…") → `Spinner` +
  `disabled` composition.
- **`Card` becomes THE panel language.** Restyle `ui/card.tsx` once to the
  flat console look (`rounded-lg`, `shadow-none`, tighter default
  padding); every panel — queue sections, console panes, mission-detail
  sidebar cards, task detail, settings — uses full `Card` composition
  (`CardHeader`/`CardTitle`/`CardContent`). The 10px-uppercase section
  label becomes the styled `CardTitle` convention for list panels.
- Components to add via CLI (from `@shadcn`): `tabs`, `toggle-group`,
  `empty`, `field`, `input-group`, `spinner`, `checkbox`, `switch`,
  `alert`. Verify availability with `search` first; anything unavailable
  in the registry for this style is composed from installed primitives
  instead — no hand-rolled substitutes for things the registry has.

### 4. Class hygiene (skill rules, enforced during the sweep)

- No `space-x-*`/`space-y-*` → `flex` + `gap-*`.
- `size-*` for equal dimensions; `truncate` shorthand; `cn()` for
  conditional classes (no template-literal ternaries).
- No manual `dark:` color overrides; no raw palette classes.
- `className` on shadcn components for layout only.

### 5. Shells, typography, primitives

- **Two sanctioned shells**, extracted as components:
  - `PageShell` — centered document pages: `container max-w-[1400px] py-8`.
    Used by: home, missions, repos, ledger, plan, retrospective, task
    detail, composer, chat, setup.
  - `ConsoleShell` — full-bleed fixed-height IDE pages: current
    `flex h-full flex-col overflow-hidden px-6 py-4`. Used by: repo
    console, mission detail.
  - Auth (login/signup) keeps its centering; marketing untouched.
- **Headings**: every `(app)` page h1 is `font-title text-3xl uppercase
  tracking-tight`. Page subtitles: `text-sm text-muted-foreground`.
- **Shared primitives** in `lib/format.ts` + `components/`:
  - `formatDateTime` (always `'en-US'`), `formatRelative`, `formatUsd`,
    `formatTokens` — single implementations; all four current duplicate
    sites migrate.
  - `PrChip` component (Badge-based) replacing both copies.
- **Link affordances**: internal navigation links end with `→`; external
  links end with `↗` + `target="_blank"`; in-prose links use solid
  underline `underline-offset-2`; no dotted-underline convention remains.

### 6. Sweep scope (every file it touches)

Pages: `home`, `missions`, `missions/new`, `missions/[id]`,
`missions/[id]/plan`, `missions/[id]/issues`, `missions/[id]/ledger`,
`missions/[id]/retrospective`, `missions/[id]/tasks/[taskId]`, `repos`,
`repos/[owner]/[repo]` (all tabs), `chat`, `setup`, `login`, `signup`
(tokens only). Components: `queue-section`, `missions-table`,
`mission-filters`, `repo-tabs`, `repo-toolbar`, `repo-budget-line`,
`workspace-list`, `issue-run-panel`, `attempt-file-browser`,
`settings-tab`, `steer-input`, `work-on-it-button`, `new-issue-dialog`,
`task-card`, `progress-pill`, `timeline`, `role-tagged-event`,
`session-log-view`, `live-refresh`, `budget-gauge`, `sparkline`,
`task-status-badge`, `mission-status-badge`, `forge-sidebar`, `nav-user`,
`ui/card`, `ui/button` (drop `accent` variant).

### 7. Out of scope

- Marketing pages and docs styling (already on the product language).
- Any behavioral change: routes, data fetching, actions, and interaction
  logic are untouched — this is a presentation-layer sweep.
- The three tick/security follow-ups from the previous plan.

## Testing

- Whole-repo `pnpm typecheck` and full suites green after every task.
- Pure formatter helpers (`lib/format.ts`) get unit tests; migrated
  call sites keep behavior (same rendered strings for same inputs —
  asserted in the helper tests, not per-component).
- Grep gates at the end of the sweep (each must return zero hits in
  `apps/web/src`, excluding `ui/`): `--forge-accent`, `emerald-`,
  `blue-500`, `space-y-`, `space-x-`, `DateTimeFormat(undefined`,
  `decoration-dotted`.
- Live browser walkthrough of every swept page in dark AND light mode;
  hydration console clean.
