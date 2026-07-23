# Mission Detail Tab Bar — Shell + Overview Tab — Design

## Motivation

The user shared a screenshot of a mobile task-management app with a top tab bar (icons for a pipeline/workflow view, a tools/settings view, and a "Tasks" board view) and a status-bucketed task board (Ready / Active / Draft, with Done and Cancelled collapsed behind counters). Forge's mission detail page (`apps/web/src/app/(app)/missions/[missionId]/page.tsx`) has no tab bar today — its sub-pages (`ledger`, `plan`, `retrospective`, `issues`) are reached via scattered inline text links, and the page shows a flat, unbucketed task list.

Turning the mission page into a tabbed shell (Overview / Pipeline / Tools / Tasks) is a bigger scope than one spec: Pipeline (a DAG view of task dependencies) and Tools (a mission settings panel) are each independent features with their own design questions. This spec covers **only the first slice**: the tab bar shell itself, plus an Overview tab that preserves today's page content. Three further specs follow once this ships:

1. **This spec** — tab bar shell + Overview tab
2. Tasks — the status-bucketed board (Ready/Active/Draft/Done/Cancelled)
3. Pipeline — DAG view of task dependencies
4. Tools — mission settings panel

## Scope

- A new `layout.tsx` at `apps/web/src/app/(app)/missions/[missionId]/` providing shared chrome (header + tab bar) across all four eventual tabs.
- A new `MissionTabs` client component rendering the four tabs, three of which (Pipeline, Tools, Tasks) are disabled in this cycle — their routes don't exist yet.
- `page.tsx` (the existing Overview content) loses its header block, which moves to the layout; everything else on the page is unchanged.
- No new routes for Pipeline/Tools/Tasks in this cycle — those are reserved paths, built in specs 2–4.
- No change to `ledger`, `plan`, `retrospective`, or `issues` routes or their existing inline links.

## File Structure & Architecture

New `layout.tsx` at `apps/web/src/app/(app)/missions/[missionId]/layout.tsx` — a Next.js App Router layout, the idiomatic mechanism for chrome shared across sibling routes. It:

- Fetches the mission once via the existing `getMission(missionId)` (from `@/lib/missions`).
- Calls `notFound()` if the mission doesn't exist — same guard `page.tsx` has today.
- Renders the header block moved verbatim from `page.tsx`: mission name (`<h1>`), `MissionStatusBadge`, mission id, and the status-dependent action buttons (`Plan Mission` / `Review plan` + `Start Mission` / `Pause` / `Resume`, plus the triage-only `View by issue →` link) — all unchanged in behavior, just relocated.
- Renders `LiveRefresh` when `mission.status === 'running' || mission.status === 'planning'` — moved from `page.tsx`. This is a genuine improvement, not just a relocation: today `LiveRefresh` only exists on the Overview page, so the ledger/plan/retrospective/issues sub-pages have no live refresh at all. Hoisting it to the layout means `router.refresh()` fires (and re-renders the whole route tree, layout included) regardless of which tab is active.
- Renders `<MissionTabs missionId={mission.id} />` below the header.
- Renders `{children}` below the tab bar — the active route's page content.

New `apps/web/src/components/mission-tabs.tsx` — a client component (`'use client'`, needed for `usePathname()`):

- Uses the existing `TabsList`/`TabsTrigger` primitives from `@/components/ui/tabs` (Radix-based, already in the app, currently used once in `issue-run-panel.tsx`) purely for visual styling — not their built-in state management, since navigation is route-based per the earlier decision, not client-side tab state.
- Each trigger is a `Link` (from `next/link`) to its route: `/missions/${missionId}` (Overview), `/missions/${missionId}/pipeline`, `/missions/${missionId}/tools`, `/missions/${missionId}/tasks`.
- The active tab is derived from `usePathname()`: exact match on `/missions/${missionId}` for Overview (not a prefix match, so it doesn't also light up for `/missions/${missionId}/ledger` etc.), and a prefix match (`pathname.startsWith(...)`) for the other three.
- Pipeline, Tools, and Tasks triggers are all disabled in this cycle (`disabled` prop on `TabsTrigger`, which already has `disabled:pointer-events-none disabled:opacity-50` styling built in) — none of their routes exist yet. Each cycle that ships a route flips its own trigger's `disabled` to `false`; no other tab-bar changes are needed.

`page.tsx` changes: remove the header block (the `<div className="title-glow ...">...</div>` at the top, now owned by the layout) and the `MissionActionButton`/`LiveRefresh`/`MissionStatusBadge` imports that block used exclusively. Everything below it — the two-thirds/one-third grid (tasks list, sidebar, timeline console) — is unchanged.

## Edge Cases

- A mission's status changes (e.g. `running` → `completed`) while the user is on a sub-tab once one exists (post-cycle-2+): handled by the same `LiveRefresh`/`router.refresh()` mechanism already in place, now live on every tab instead of only Overview — no new mechanism needed.
- Navigating directly to `/missions/[missionId]/pipeline` or `/tools` by URL (bypassing the disabled tab) in this cycle: 404s naturally, since no `page.tsx` exists at those paths — Next.js's default behavior, no special handling needed.
- The triage-only `View by issue →` link and the status-dependent action buttons must retain their exact existing conditions (`mission.plannerStrategy === 'triage'`, `mission.status === 'draft'/'planning'/'running'/'paused'`) — copied verbatim, not re-derived, to avoid subtly changing behavior during the move.

## Testing

- No dedicated test file exists for `page.tsx` today (it's a server component rendering path, not currently unit-tested); this spec doesn't introduce one, consistent with the existing pattern.
- `mission-tabs.tsx` gets a small component test (React Testing Library, matching whatever convention `apps/web` already uses for client components — check for an existing example before writing this test in the implementation plan) asserting: the correct tab is marked active for a given pathname (exact-match for Overview, prefix-match for the other three), and Pipeline/Tools/Tasks render as disabled.
- Manual verification: start the dev server, open a mission's detail page, confirm the header and tab bar render, confirm Overview content is unchanged from before this change, confirm Pipeline/Tools/Tasks tabs are visibly disabled and unclickable.

## Explicitly Out of Scope

- The Tasks board itself (Ready/Active/Draft/Done/Cancelled buckets, the "Ready" status-mapping gap, actions like drag-and-drop) — spec 2.
- The Pipeline DAG view — spec 3.
- The Tools settings panel — spec 4.
- Any change to `ledger`/`plan`/`retrospective`/`issues` routes' own inline navigation links — untouched by this cycle.
