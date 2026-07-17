/**
 * Shared display formatters used across the dashboard UI.
 *
 * Consolidated from the previously-duplicated implementations in
 * `progress-pill.tsx` (formatRelative/formatTokens/formatUsd) and
 * `issue-run-panel.tsx` (the 'en-US' Intl.DateTimeFormat options). Pure
 * functions only — no `'use client'` — so this module is safe to import
 * from Server Components.
 */

/** "Jul 17, 9:43 PM" by default; pass `{ seconds: true }` for "Jul 17, 9:43:00 PM". */
export function formatDateTime(date: Date, opts?: { seconds?: boolean }): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    ...(opts?.seconds ? { second: 'numeric' as const } : {}),
  }).format(date);
}

/** "42s ago" | "5m ago" | "3h ago" | "2d ago". `nowMs` is injectable for tests. */
export function formatRelative(date: Date, nowMs: number = Date.now()): string {
  const s = Math.floor((nowMs - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "$0" | "$0.19" | "$12" (whole dollars round to no decimals once >= $1). */
export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

/** "512" | "36.6k" | "1.32M" */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** "21:07:19Z" — deterministic UTC time for dense console/log-tail displays,
 *  where locale-aware formatting would risk a server/client hydration
 *  mismatch (the same reasoning as formatDateTime's fixed 'en-US' locale,
 *  but console voice is UTC HH:MM:SS, not a localized clock). */
export function formatConsoleTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '--:--:--Z';
  return date.toISOString().slice(11, 19) + 'Z';
}
