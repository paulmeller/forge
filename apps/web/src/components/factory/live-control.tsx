'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { FACTORY_ACCENT } from './theme';

const INTERVAL_MS = 15_000;

/**
 * The "LIVE" toggle in the factory header. When on, it re-runs the server
 * component every {@link INTERVAL_MS} via `router.refresh()` (the page is
 * `force-dynamic`, so each refresh re-queries the database). Defaults on.
 */
export function LiveControl() {
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [, startTransition] = useTransition();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      startTransition(() => router.refresh());
      setTick((t) => t + 1);
    }, INTERVAL_MS);
    return () => clearInterval(id);
  }, [live, router]);

  return (
    <button
      onClick={() => setLive((v) => !v)}
      className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/60 transition-colors hover:text-white"
      title={live ? 'Live updates on — click to pause' : 'Paused — click to resume'}
      aria-pressed={live}
    >
      <span
        className={live ? 'factory-pulse' : ''}
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: live ? FACTORY_ACCENT : '#52525b',
        }}
        // re-key the ping on each refresh so it visibly blinks
        key={tick}
      />
      {live ? 'Live' : 'Paused'}
    </button>
  );
}
