'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

import { activateRepo, deactivateRepo, triggerManualTick } from './actions';

export function RepoToolbar({
  repo,
  containerStatus,
}: {
  repo: string;
  containerStatus: 'running' | 'paused' | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggleActive() {
    setError(null);
    startTransition(async () => {
      const result =
        containerStatus === 'paused' ? await activateRepo(repo) : await deactivateRepo(repo);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleManualTick() {
    setError(null);
    startTransition(async () => {
      const result = await triggerManualTick();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex shrink-0 items-center gap-2">
        {containerStatus ? (
          <Button variant="outline" size="sm" onClick={handleToggleActive} disabled={pending}>
            {containerStatus === 'paused' ? 'Activate' : 'Deactivate'}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={handleManualTick} disabled={pending}>
          Manual
        </Button>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          Refresh
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
            GitHub ↗
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link href={`/missions/new?repo=${encodeURIComponent(repo)}`}>Run a goal on this repo →</Link>
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
