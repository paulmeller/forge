# Fleet-Wide Trace Mining — Design

## Motivation

Forge already has per-mission observability: `rollups.ts` aggregates counts/tokens/timing for a given set of mission IDs, and `retrospectives.ts` runs an LLM retrospective over one mission's ledger. Neither aggregates *across* missions or repos. Two independent threads this session converged on the same gap:

- Comparing Forge's stack to a typical "software factory" architecture, the missing piece is cross-mission reporting: which gates reject most, why tasks get abandoned, ground-truth reporting of what shipped this week.
- Addy Osmani's "Software Factories, Light and Dark" essay argues that deciding how much autonomy to grant a repo's factory (e.g. Forge's per-repo `aiReviewEnabled`/`selfVerifyEnabled` toggles) needs evidence, not gut feel. Cross-mission gate-outcome data is exactly that evidence.

This feature is scoped as **descriptive reporting only** — it surfaces evidence for a human to act on (e.g. deciding whether to loosen a repo's gates). It does not recommend actions or change behavior automatically.

## Scope

- A new fleet-wide report, viewable as a page in `forge-web`.
- Built so the same aggregation logic can later feed a scheduled digest (email/Slack) without rework — that digest is explicitly **not** part of this spec, only a constraint on how the aggregation module is shaped.
- Read-only. No new write paths, no schema changes, no automated actions.

## Data Model & Aggregation

New module: `apps/web/src/lib/fleet-report.ts`, structured like the existing `rollups.ts` — plain functions running grouped queries against `tasks` and `ledgerEvents`. No new tables.

Repo grouping uses `tasks.repo` (not `missions.targetRepos` — a mission can span multiple repos via campaign missions, so task-level `repo` is the only reliable grouping key).

Gate-outcome categories are hardcoded against the existing fixed `eventType` vocabulary (~38 literals, confirmed via codebase survey — not data-driven):

- CI: `ci.passed` / `ci.failed` (`ci.retry_dispatched` counted as an attempt, not a separate outcome)
- Self-verify: `verify.passed` / `verify.retry_dispatched` / `verify.escalated`
- AI-review: `ai_review.approved` / `ai_review.rejected` / `ai_review.escalated`
- Abandon reasons: `task.abandoned` events, grouped by the exact `payload.reason` string (free text today, but the reconciler only ever writes a small fixed set of literal strings — grouping by exact text match needs no schema change; if the wording in `reconciler.ts` changes later, that bucket will silently split into two, which is an accepted trade-off for staying in scope)
- Spend: reuses `rollups.ts`'s existing `$5/1M token` pricing convention

Two exported functions:

```ts
export async function getFleetOverview(windowDays: 7 | 30 | 90): Promise<Array<{
  repo: string
  taskCounts: { merged: number; resolved: number; abandoned: number; failed: number; inFlight: number }
  ciPassRate: number | null   // null = no CI-relevant events in window
  verify: { passRate: number | null; retries: number; escalated: number }
  aiReview: { approveRate: number | null; rejected: number; escalated: number }
  spentUsd: number
  topAbandonReasons: Array<{ reason: string; count: number }>  // top 3
}>>

export async function getRepoTrend(repo: string, windowDays: 7 | 30 | 90): Promise<Array<{
  bucketStart: Date
  ciPassRate: number | null
  verifyPassRate: number | null
  aiReviewApproveRate: number | null
}>>
```

`getRepoTrend` buckets the window into sub-periods for the trend chart, reusing the bucketing approach `rollups.ts`'s `sparklinesForMissions` already uses (30-bucket time series): 30-day window → daily buckets, 90-day window → weekly buckets, 7-day window → daily buckets.

A repo with zero gate-relevant events in a bucket/window renders that rate as `null` (shown as "—" in the UI) rather than `0%` or `NaN` — division-by-zero is guarded the same way throughout.

## API Surface

Two new read-only routes, following the existing REST pattern used elsewhere in `apps/web/src/app/(app)/api/`:

```
GET /api/reports/fleet?window=30
GET /api/reports/fleet/[repo]?window=30
```

- `window` is `7 | 30 | 90`, default `30`; any other value 400s.
- Both routes call the existing `withAuth` pattern (401 if unauthenticated).
- The overview route filters results to repos the authenticated user has connected (same ownership check used by the chat route's `list_repos` tool).
- The per-repo route 404s if the requested repo isn't one of the user's connected repos — it does not trust the `[repo]` path param blindly.
- A repo can appear in the overview even if it was later disconnected in `/setup` — historical data is still shown, matching how `rollupMissions` already treats past data.

## Frontend

New route: `/reports/fleet`, added to the existing app nav alongside Missions/Setup.

**Default view** — an all-repos overview table, one row per repo, sorted by abandon-rate descending (the repo needing the most attention surfaces first). A window selector (7/30/90 days, default 30) sits above the table. Repos with zero tasks in the window are simply omitted from the table, not shown as a zeroed row.

**Drill-down view** — clicking a repo row navigates to `/reports/fleet/[repo]`, showing:
- Trend charts (CI pass rate, verify pass rate, AI-review approve rate) across the window's sub-periods
- Top abandon reasons for that repo/window
- Spend for that repo/window
- The same window selector, carried over from the overview

Uses the app's existing UI kit/table components (whatever the missions list already uses) — no new charting library. Trend charts render as lightweight inline SVG/sparklines, consistent with however `sparklinesForMissions` is already rendered today.

## Edge Cases

- No gate-relevant events yet for a repo/bucket → rate shown as "—", not `0%`/`NaN`.
- Repo disconnected from `/setup` but has historical tasks → still shown.
- Unauthenticated request → 401 (existing `withAuth`).
- Requested repo not owned by the user → 404.
- Invalid `window` query param → 400.

## Testing

- `fleet-report.test.ts` — DB-integration test using the same throwaway-libSQL-file pattern as `apps/web/src/app/(app)/api/chat/route.test.ts`. Seeds tasks + ledger events across 2+ repos and asserts exact rates, counts, and bucket boundaries — this is where the aggregation math gets verified.
- Two thin route tests (`route.test.ts` for each new endpoint) asserting auth and repo-ownership scoping only — they don't re-verify aggregation math already covered by `fleet-report.test.ts`.
- No new frontend test framework introduced; follow whatever component-test convention (if any) `apps/web` already uses elsewhere, or skip UI tests if none exists today.

## Explicitly Out of Scope

- Scheduled digest delivery (email/Slack) — a future feature; this spec only ensures `fleet-report.ts`'s functions return plain data reusable by that future job, not JSX or HTTP-shaped responses.
- Any automatic action (e.g. auto-suggesting or auto-flipping `aiReviewEnabled`/`selfVerifyEnabled`) — this feature is read-only reporting.
- A structured `reasonCode` column for abandon reasons — deferred; exact-text grouping over the reconciler's existing small fixed string set is sufficient for now.
- Custom date-range picker — only the fixed 7/30/90-day presets are supported.
