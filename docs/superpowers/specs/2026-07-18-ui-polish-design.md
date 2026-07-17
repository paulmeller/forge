# UI Polish — Consistent, Usable, Beautiful (shadcn + AgentStep brand)

**Status:** Approved direction (design review LGTM'd 2026-07-18). Supersedes nothing; builds on `2026-07-17-ui-consistency-shadcn-design.md`.

## Goal

Polish every page of Forge to a consistent, usable, beautiful standard while keeping the shadcn component system and the AgentStep brand exactly as established: semantic tokens, new-york radix components, VVDSFifties display type, lime-on-black dark / near-black-on-white light, Geist Mono for data. This is polish and two page redesigns — not a visual rebrand.

**Aesthetic direction (committed):** industrial control room with a poster headline voice. Restrained, precise, mono-data-heavy; one signature atmosphere effect and one motion moment per page. Elegance through discipline, not decoration.

## Non-Goals

- No new fonts, colors, or tokens beyond what exists (`--live`, `--warning` included).
- No new runtime dependencies. Motion is CSS-only.
- No information-architecture changes (routes, nav, page inventory unchanged).
- Not touching: marketing pages, docs, `src/components/ui/` internals (except additive utility classes in `globals.css`).

## 1. Voice: humanized status vocabulary

One shared map in `apps/web/src/lib/status-labels.ts`; unit-tested; used by every Badge/chip that faces the user. Machine strings (snake_case) remain ONLY in console surfaces: ledger event rows, timeline raw payloads, `agent.log`-style panes.

Exact strings:

| machine | label |
|---|---|
| queued | Queued |
| dispatching | Dispatching |
| running | Running |
| opening_pr | Opening PR |
| awaiting_ci | Waiting on CI |
| awaiting_verify | Verifying |
| awaiting_ai_review | AI review |
| merging | Merging |
| awaiting_review | Needs review |
| failed | Failed |
| merged | Merged |
| resolved | Resolved |
| abandoned | Abandoned |
| reproducing | Reproducing |
| fixing | Fixing |
| fix_review | Reviewing fix |
| fixed | Fixed |
| not_reproduced | Not reproduced |
| fix_skipped | Fix skipped |
| draft | Draft |
| planning | Planning |
| paused | Paused |
| completed | Completed |
| cancelled | Cancelled |

`statusLabel(s: string): string` falls back to the raw string for unknown values (never throws; never silently hides new statuses).

## 2. Typography rule

- `font-title` (VVDSFifties, uppercase): page-level H1s and brand marks ONLY.
- Identifiers — repo names, issue refs, mission/task/session IDs — are ALWAYS Geist Mono, never display type. The repo-console header switches from font-title to mono (`font-mono text-2xl`), which also fixes the known two-line wrap clipping the toolbar CTA at ~1400px.
- Section labels codified as a `SectionLabel` component: `font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` (the emergent "NEEDS YOU / TASKS (2)" style becomes the one blessed way).

## 3. Chip grammar

Three chip species, already existing, now codified and used exclusively:
- **Status Badge** — `Badge` with humanized label.
- **Mono data chip** — `rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground` (cost, tokens, counts, durations). Extract as `DataChip`.
- **Link chip** — PrChip (unchanged).

Canonical row order everywhere a task/mission row renders chips: `[progress] [PR↗] [$cost] [kind] [status] · relative-time` (relative-time is text, not a chip). Maximum four chips visible per row; when more exist, collapse lowest-priority first — drop order: kind, then cost — into a single `+N` mono data chip (static, no popover — YAGNI). All numeric chips `tabular-nums`.

## 4. Motion system (CSS-only)

Additive utilities in `globals.css`:
- `.rise` — fade-up on load: `opacity 0→1`, `translateY(4px)→0`, 300ms ease-out; `.rise-1` … `.rise-6` add 40ms stagger increments. Applied to page-level sections/cards on: home, missions, repos, setup, composer, mission detail.
- Row hover: `transition-colors duration-150` on interactive rows (many already have it via `hover:bg-accent`; normalize).
- Console line append: `.console-line-in` fade-in 200ms, applied by SessionLogView/timeline as lines mount.
- All wrapped in `@media (prefers-reduced-motion: no-preference)`; reduced-motion users get instant rendering.
- One orchestrated moment per page; no scroll-triggered effects, no springs.

## 5. Atmosphere (one signature)

A single radial glow behind each page H1, dark mode only: absolutely-positioned pseudo-element in `PageShell`/`ConsoleShell` header area, `radial-gradient(600px circle at 20% 0%, --primary at 4% opacity, transparent 70%)`, `pointer-events-none`. Light mode: none. No grain, no textures elsewhere — one effect, applied identically, or it isn't a signature.

## 6. Per-page polish

**Home** — metric tiles become the hero: numbers in `text-4xl font-semibold tabular-nums`, each tile wraps in a Link to what it counts (merged → /missions?status=completed, active → /home#working, spend → /missions, repos → /repos); labels stay as-is. Queue rows adopt chip grammar + humanized statuses. No sparkline in tiles (YAGNI).

**Missions** — row subtitle no longer duplicates the name: for issue missions (name already contains the issue ref) the subtitle is omitted; for campaign/fleet missions it shows the mono repo/scope. Never render the same string twice in one cell. Progress cell obeys the four-chip cap with `+N` overflow, never wraps to a second line (`whitespace-nowrap` + overflow chip). Backend column renders a compact mono data chip (`ma` / `gw` with `title` attr for the full name). Filter strip gets grouped mono captions via `SectionLabel` (STATUS / BACKEND / KIND) above each ToggleGroup.

**Repo console** — header identifier to mono (see §2). Stage chips use humanized labels ("Reviewing fix", "Needs review"). The bottom "Awaiting review" muted pseudo-button becomes a plain status line (`SectionLabel` + text) — never button-shaped unless clickable. File table + console output unify under one framed "RUN OUTPUT" treatment: shared border, mono header bar via `SectionLabel`, console keeps fixed height.

**Mission detail** — Budget card, uncapped state: show `No cap · $X spent` text and render NO bars/ticks (bars only when a cap exists). Execution card: if it has no content, it doesn't render. Timeline timestamps stay raw-Z but styled deliberately: `font-mono text-[10px] text-muted-foreground` (console voice, on purpose).

**Repos (redesign)** — searchable card grid: client-side filter Input, responsive grid (`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`) of repo Cards showing mono repo name, open-issue count, live dot + humanized status when a mission is active, spend to date, last-activity relative time. Data from one server-side aggregation over existing missions/tasks tables (no schema changes). Repos with activity sort first, then alphabetical.

**Setup (redesign)** — success Card (`CardTitle` "You're all set", count line, `@forge` hint) + primary CTA "Browse your repos →" (/repos) + the repo list collapsed behind a shadcn Collapsible ("Show all 104 repos"), rendered as a plain mono list when expanded. No asterisk bullets.

**Chat, task detail, ledger, composer** — inherit the systems (labels, chips, motion, atmosphere) only; no page-specific work.

## 7. Decomposition into plans

- **Plan A — polish systems + page polish:** §1-§5 primitives (status-labels + tests, SectionLabel, DataChip, motion utilities, glow) and the home / missions / repo-console / mission-detail items. Ships alone.
- **Plan B — repos + setup redesign:** §6 Repos and Setup pages, consuming Plan A's primitives. Ships after A.

## 8. Acceptance

- `pnpm typecheck` clean (all projects); web tests pass; `status-labels` unit-tested (every machine string in the table maps; unknown falls back).
- Grep gates: no `animate-` outside `ui/`, the sanctioned motion utilities, and the existing `animate-pulse` live dots; no `font-title` on identifier elements (checked in review, not grep-able mechanically).
- Browser walkthrough dark + light: humanized labels on every non-console badge; no chip-wrap on missions rows; glow visible dark-only; motion absent under reduced-motion emulation; repos page filters 111 repos responsively.
