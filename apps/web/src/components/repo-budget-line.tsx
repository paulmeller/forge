import { cn } from '@/lib/utils';
import type { RepoBudget } from '@/lib/repo-budget';

function usd(n: number): string {
  return n < 1 && n > 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
}

/** Compact one-line budget readout for the repo console header. */
export function RepoBudgetLine({ budget }: { budget: RepoBudget }) {
  const { spentUsd, capUsd, pct } = budget;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="font-mono tabular-nums">
        Spent {usd(spentUsd)}
        {capUsd !== null ? ` · cap ${usd(capUsd)}` : ' · no cap'}
      </span>
      {pct !== null ? (
        <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              'absolute inset-y-0 left-0 rounded-full',
              pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-foreground',
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
