# Repo Console Toolbar Overflow — Design

**Status:** Approved (2026-07-18). Small standalone follow-up to the UI polish work (`2026-07-18-ui-polish-design.md`), not folded into Plan B (`/repos`, `/setup` redesign) since it's a distinct concern.

## Problem

The repo-console header's action cluster has 7 buttons (`+ New issue`, `View missions`, `Deactivate`/`Activate`, `Manual`, `Refresh`, `GitHub ↗`, `Run a goal on this repo →`) totaling ~716px. In the narrow two-column issue-workspace layout (~895px header), this squeezes the repo-name title down to ~163px, truncating a name like `paulmeller/forge-sandbox` to `paulmeller…`. Verified live during the UI polish final review; competitor research (Cursor, GitHub Agent HQ, and general toolbar-design authorities PatternFly/Whitespace) converges on the same fix: collapse secondary actions into a single overflow menu, keep only the 1-2 most-used actions inline.

## Design

Keep inline: `+ New issue` (creates work) and `Run a goal on this repo →` (the primary CTA, already the emphasized/default-variant button).

Collapse into one ghost icon-only "more actions" `DropdownMenu` (lucide `MoreHorizontal` icon), in their current relative order: `View missions`, `Activate`/`Deactivate`, `Manual`, `Refresh`, `GitHub ↗`.

`RepoToolbar` (`apps/web/src/app/(app)/repos/[owner]/[repo]/repo-toolbar.tsx`) gains a new prop `missionsHref: string | null`. The parent page (`page.tsx`) stops rendering the standalone "View missions" `Button asChild variant="ghost"` and instead passes `mission ? `/missions?repo=${encodeURIComponent(repo)}` : null` as `missionsHref`. All other props/behavior (`repo`, `containerStatus`) are unchanged.

Inside `RepoToolbar`: the existing `pending`/`error` state and the `handleToggleActive`/`handleManualTick` handlers are unchanged — they're just invoked from `DropdownMenuItem onClick` instead of `Button onClick`. The `error` paragraph continues to render below the action row, unchanged. `Refresh` becomes a `DropdownMenuItem` calling the same `router.refresh()`. `GitHub ↗` and `View missions` become `DropdownMenuItem asChild` wrapping their existing `Link`s (external target/rel preserved for GitHub).

No new dependencies (`DropdownMenu` primitives and `lucide-react` are already used elsewhere, e.g. `nav-user.tsx`). No data/schema changes. No change to `+ New issue` (`NewIssueDialog`) or `Run a goal` styling/href.

## Acceptance

- Header inline cluster drops from 7 buttons to 2 buttons + 1 icon trigger (~313px vs ~716px).
- All 5 collapsed actions retain identical behavior (activate/deactivate toggle, manual tick, refresh, external GitHub link, missions link) — verified by exercising each from the dropdown.
- `pnpm typecheck` clean (all projects); no new tests required (no new business logic, only markup restructuring — existing `repo-toolbar` behavior has no unit tests today and this doesn't change that).
- Browser-verified: repo name no longer truncates at the ~895px narrow-layout width for `paulmeller/forge-sandbox`; dropdown opens/closes correctly in dark and light mode.
