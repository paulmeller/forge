import { cn } from '@/lib/utils';
import { formatRelative, formatTokens, formatUsd } from '@/lib/format';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function Chip({
  children,
  tone,
  timeSensitive,
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'live' | 'good' | 'bad';
  timeSensitive?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        tone === 'live' && 'bg-foreground text-background',
        tone === 'good' && 'bg-live/15 text-live',
        tone === 'bad' && 'bg-destructive/15 text-destructive',
        (!tone || tone === 'muted') && 'bg-muted text-muted-foreground',
      )}
      // Relative times depend on Date.now(); SSR'd value will differ from
      // hydration value by a few hundred ms — that's fine, suppress the warning.
      suppressHydrationWarning={timeSensitive}
    >
      {children}
    </span>
  );
}

// ---------------- Mission-level pill ---------------- //

export type MissionRollup = {
  total: number;
  inFlight: number; // dispatching, running, turn_ended, opening_pr, awaiting_ci, merging
  awaitingReview: number;
  merged: number;
  resolved: number; // triage reproduce Tasks settled with a verdict (no PR)
  abandoned: number;
  failed: number;
  spentUsd: number; // dollars
  spentTokens: number;
  lastEventAt: Date | null;
};

export function MissionProgressPill({ rollup }: { rollup: MissionRollup }) {
  const settled =
    rollup.merged + rollup.resolved + rollup.awaitingReview + rollup.abandoned + rollup.failed;
  const pct = rollup.total === 0 ? 0 : Math.round((settled / rollup.total) * 100);

  // Priority-ordered status chips; pct + cost always render, so at most 2
  // status chips are visible (4-chip cap, spec §3) — the rest collapse to +N.
  const statusChips: Array<{ key: string; tone: 'live' | 'good' | 'bad' | 'muted'; label: string }> = [];
  if (rollup.inFlight > 0) statusChips.push({ key: 'inflight', tone: 'live', label: `${rollup.inFlight} in flight` });
  if (rollup.failed > 0) statusChips.push({ key: 'failed', tone: 'bad', label: `${rollup.failed} failed` });
  if (rollup.merged > 0) statusChips.push({ key: 'merged', tone: 'good', label: `${rollup.merged} merged` });
  if (rollup.awaitingReview > 0) statusChips.push({ key: 'review', tone: 'muted', label: `${rollup.awaitingReview} review` });
  if (rollup.resolved > 0) statusChips.push({ key: 'triaged', tone: 'muted', label: `${rollup.resolved} triaged` });
  if (rollup.abandoned > 0) statusChips.push({ key: 'abandoned', tone: 'muted', label: `${rollup.abandoned} abandoned` });
  const visible = statusChips.slice(0, 2);
  const hidden = statusChips.length - visible.length;

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <Chip tone="muted">
        <span className="font-semibold text-foreground">{pct}%</span>
        <span className="ml-1 text-muted-foreground">{settled}/{rollup.total}</span>
      </Chip>
      {visible.map((c) => (
        <Chip key={c.key} tone={c.tone}>{c.label}</Chip>
      ))}
      {hidden > 0 && <Chip tone="muted">+{hidden}</Chip>}
      <Chip tone="muted">{formatUsd(rollup.spentUsd)}</Chip>
      <span className="text-[11px] tabular-nums text-muted-foreground" suppressHydrationWarning>
        {rollup.lastEventAt ? formatRelative(rollup.lastEventAt) : '—'}
      </span>
    </div>
  );
}

// ---------------- Task-level pill ---------------- //

export type TaskRollup = {
  toolCalls: number;
  toolResults: number;
  costTokens: number;
  startedAt: Date | null;
  endedAt: Date | null;
};

export function TaskProgressPill({
  rollup,
  variant = 'compact',
}: {
  rollup: TaskRollup;
  variant?: 'compact' | 'expanded';
}) {
  const elapsed =
    rollup.startedAt && rollup.endedAt
      ? rollup.endedAt.getTime() - rollup.startedAt.getTime()
      : rollup.startedAt
        ? Date.now() - rollup.startedAt.getTime()
        : 0;

  const live = !!rollup.startedAt && !rollup.endedAt;
  const toolsLabel =
    rollup.toolCalls === 0
      ? '—'
      : rollup.toolResults < rollup.toolCalls
        ? `${rollup.toolResults}/${rollup.toolCalls} tools`
        : `${rollup.toolCalls} tools`;

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', variant === 'expanded' && 'gap-2')}>
      <Chip tone={live ? 'live' : 'muted'}>{toolsLabel}</Chip>
      {elapsed > 0 && (
        <Chip tone="muted" timeSensitive={live}>
          {formatElapsed(elapsed)}
        </Chip>
      )}
      {rollup.costTokens > 0 && <Chip tone="muted">{formatTokens(rollup.costTokens)} tok</Chip>}
    </div>
  );
}
