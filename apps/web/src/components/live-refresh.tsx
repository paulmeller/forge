'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Periodically calls router.refresh() to re-fetch server data.
 *
 * Phase B uses polling instead of true SSE (PRD §16.6) because the tick
 * cadence is 60s — anything more responsive than 5s is wasted. The visible
 * indicator turns this from "magic background work" into operator-visible
 * behaviour they can pause if they don't want it.
 */
export function LiveRefresh({
  intervalMs = 5000,
  enabled: initialEnabled = true,
}: {
  intervalMs?: number;
  enabled?: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      router.refresh();
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((e) => !e)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] tabular-nums',
        enabled
          ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200'
          : 'bg-muted text-muted-foreground',
      )}
      title={enabled ? 'Click to pause auto-refresh' : 'Click to resume auto-refresh'}
    >
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          enabled ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground',
        )}
        aria-hidden
      />
      <span>{enabled ? `Live · ${intervalMs / 1000}s` : 'Paused'}</span>
      {enabled && tick > 0 && <span className="text-emerald-700/70 dark:text-emerald-400/70">×{tick}</span>}
    </button>
  );
}
