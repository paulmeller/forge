'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { activateRepo, deactivateRepo, triggerManualTick } from './actions';

export function RepoToolbar({
  repo,
  containerStatus,
  missionsHref,
}: {
  repo: string;
  containerStatus: 'running' | 'paused' | null;
  missionsHref: string | null;
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 px-0" disabled={pending}>
              <MoreHorizontal className="size-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {missionsHref ? (
              <DropdownMenuItem asChild>
                <Link href={missionsHref}>View missions</Link>
              </DropdownMenuItem>
            ) : null}
            {containerStatus ? (
              <DropdownMenuItem onClick={handleToggleActive} disabled={pending}>
                {containerStatus === 'paused' ? 'Activate' : 'Deactivate'}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={handleManualTick} disabled={pending}>
              Manual
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.refresh()}>Refresh</DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
                GitHub ↗
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild size="sm">
          <Link href={`/missions/new?repo=${encodeURIComponent(repo)}`}>Run a goal on this repo →</Link>
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
