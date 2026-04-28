import { cn } from '@/lib/utils';

function formatUsd(n: number | null): string {
  if (n === null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
}
function formatTokens(n: number | null): string {
  if (n === null) return '—';
  return new Intl.NumberFormat().format(n);
}

function Bar({ pct, threshold, tone }: { pct: number; threshold: number; tone: 'normal' | 'warn' | 'over' }) {
  return (
    <div className="relative h-1.5 w-full rounded-full bg-muted">
      <div
        className={cn(
          'absolute inset-y-0 left-0 rounded-full',
          tone === 'normal' && 'bg-foreground',
          tone === 'warn' && 'bg-amber-500',
          tone === 'over' && 'bg-destructive',
        )}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
      {threshold > 0 && threshold < 100 && (
        <div
          className="absolute -top-1 h-3.5 w-0.5 bg-muted-foreground/50"
          style={{ left: `${threshold}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}

export function BudgetGauge({
  spentUsd,
  budgetUsd,
  spentTokens,
  budgetTokens,
  thresholdPct,
}: {
  spentUsd: number;
  budgetUsd: number | null;
  spentTokens: number;
  budgetTokens: number | null;
  thresholdPct: number;
}) {
  const usdPct = budgetUsd && budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0;
  const tokenPct = budgetTokens && budgetTokens > 0 ? (spentTokens / budgetTokens) * 100 : 0;
  const tone = (pct: number): 'normal' | 'warn' | 'over' =>
    pct >= 100 ? 'over' : pct >= thresholdPct ? 'warn' : 'normal';

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">USD</span>
          <span className="font-mono tabular-nums">
            {formatUsd(spentUsd)} <span className="text-muted-foreground">/ {formatUsd(budgetUsd)}</span>
          </span>
        </div>
        <Bar pct={usdPct} threshold={thresholdPct} tone={tone(usdPct)} />
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Tokens</span>
          <span className="font-mono tabular-nums">
            {formatTokens(spentTokens)}{' '}
            <span className="text-muted-foreground">/ {formatTokens(budgetTokens)}</span>
          </span>
        </div>
        <Bar pct={tokenPct} threshold={thresholdPct} tone={tone(tokenPct)} />
      </div>
      <p className="text-[10px] text-muted-foreground">Auto-pause at {thresholdPct}%.</p>
    </div>
  );
}
