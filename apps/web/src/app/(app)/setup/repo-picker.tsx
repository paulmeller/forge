'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { syncRepos } from './actions';

export function RepoPicker({
  installationId,
  ghRepos,
  connectedRepos,
}: {
  installationId: string;
  ghRepos: string[] | null;
  connectedRepos: string[];
}) {
  const router = useRouter();
  const availableRepos = ghRepos ?? connectedRepos;
  const [checked, setChecked] = useState<Set<string>>(new Set(connectedRepos));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const sortedRepos = useMemo(
    () => [...availableRepos].sort((a, b) => a.localeCompare(b)),
    [availableRepos],
  );
  const filteredRepos = useMemo(
    () => sortedRepos.filter((repo) => repo.toLowerCase().includes(query.toLowerCase())),
    [sortedRepos, query],
  );

  // TanStack Virtual's useVirtualizer() returns functions that can't be
  // memoized safely, so the compiler correctly skips memoizing this
  // component. That's an accurate diagnosis (not a false positive) — nothing
  // here is misused, so there's nothing to change; suppressed to keep lint
  // clean without swapping virtualization libraries.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredRepos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
  });

  function toggle(repo: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  async function handleSave() {
    setError('');
    setPending(true);
    try {
      const result = await syncRepos(installationId, [...checked]);
      if (result?.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {ghRepos === null && (
        <p className="text-xs text-muted-foreground">
          Couldn&rsquo;t reach GitHub to list new repos right now — showing already-connected repos
          only. Try again shortly to add more.
        </p>
      )}
      {availableRepos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repos available. Check the GitHub App&rsquo;s repository access settings.
        </p>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repos..."
          />
          {filteredRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos match &ldquo;{query}&rdquo;.</p>
          ) : (
            <div ref={scrollRef} className="max-h-80 overflow-y-auto rounded-md border p-3">
              <div
                style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const repo = filteredRepos[virtualItem.index]!;
                  return (
                    <label
                      key={virtualItem.key}
                      className="absolute left-0 top-0 flex w-full items-center gap-2 text-sm"
                      style={{
                        height: virtualItem.size,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <Checkbox checked={checked.has(repo)} onCheckedChange={() => toggle(repo)} />
                      <span className="font-mono">{repo}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button onClick={handleSave} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Save selection ({checked.size} selected)
      </Button>
    </div>
  );
}
