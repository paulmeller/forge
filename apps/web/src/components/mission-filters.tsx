'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const STATUSES = ['draft', 'planning', 'running', 'paused', 'completed', 'cancelled'] as const;
const BACKENDS = ['managed-agents', 'gateway'] as const;
const KINDS = ['all', 'campaigns', 'issues'] as const;

export function MissionFilters({ basePath = '/missions' }: { basePath?: string } = {}) {
  const router = useRouter();
  const params = useSearchParams();

  const activeStatuses = params.get('status')?.split(',').filter(Boolean) ?? [];
  const activeBackend = params.get('backend') ?? '';
  const search = params.get('q') ?? '';
  const activeKind = params.get('kind') || 'all';

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [params, router, basePath],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status pills */}
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        value={activeStatuses}
        onValueChange={(values) => updateParam('status', values.join(','))}
      >
        {STATUSES.map((s) => (
          <ToggleGroupItem key={s} value={s} className="text-[11px]">
            {s}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <span className="mx-1 h-4 w-px bg-border" />

      {/* Backend pills */}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={activeBackend}
        onValueChange={(value) => updateParam('backend', value)}
      >
        {BACKENDS.map((b) => (
          <ToggleGroupItem key={b} value={b} className="font-mono text-[11px]">
            {b}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

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

      <span className="mx-1 h-4 w-px bg-border" />

      {/* Kind pills */}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={activeKind}
        onValueChange={(value) => updateParam('kind', value === 'all' ? '' : value)}
      >
        {KINDS.map((k) => (
          <ToggleGroupItem key={k} value={k} className="text-[11px] capitalize">
            {k}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {(activeStatuses.length > 0 ||
        activeBackend ||
        search ||
        activeKind !== 'all' ||
        params.get('repo')) && (
        <button
          type="button"
          onClick={() => router.replace(basePath, { scroll: false })}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}
