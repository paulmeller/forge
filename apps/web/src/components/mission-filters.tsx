'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { Input } from '@/components/ui/input';

const STATUSES = ['draft', 'planning', 'running', 'paused', 'completed', 'cancelled'] as const;
const BACKENDS = ['managed-agents', 'gateway'] as const;

export function MissionFilters() {
  const router = useRouter();
  const params = useSearchParams();

  const activeStatuses = params.get('status')?.split(',').filter(Boolean) ?? [];
  const activeBackend = params.get('backend') ?? '';
  const search = params.get('q') ?? '';

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(`/missions${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [params, router],
  );

  const toggleStatus = useCallback(
    (status: string) => {
      const current = new Set(activeStatuses);
      if (current.has(status)) current.delete(status);
      else current.add(status);
      updateParam('status', Array.from(current).join(','));
    },
    [activeStatuses, updateParam],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status pills */}
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => toggleStatus(s)}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
            activeStatuses.includes(s)
              ? 'border-foreground bg-foreground text-background'
              : 'border-border bg-card text-muted-foreground hover:border-foreground/30'
          }`}
        >
          {s}
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-border" />

      {/* Backend pills */}
      {BACKENDS.map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => updateParam('backend', activeBackend === b ? '' : b)}
          className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition ${
            activeBackend === b
              ? 'border-foreground bg-foreground text-background'
              : 'border-border bg-card text-muted-foreground hover:border-foreground/30'
          }`}
        >
          {b}
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-border" />

      {/* Search */}
      <Input
        placeholder="Search by repo..."
        defaultValue={search}
        onChange={(e) => {
          // Debounce via setTimeout
          const value = e.target.value;
          const el = e.target;
          clearTimeout((el as unknown as { _t?: ReturnType<typeof setTimeout> })._t);
          (el as unknown as { _t?: ReturnType<typeof setTimeout> })._t = setTimeout(
            () => updateParam('q', value),
            300,
          );
        }}
        className="h-7 w-44 text-xs"
      />

      {(activeStatuses.length > 0 || activeBackend || search) && (
        <button
          type="button"
          onClick={() => router.replace('/missions', { scroll: false })}
          className="text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}
