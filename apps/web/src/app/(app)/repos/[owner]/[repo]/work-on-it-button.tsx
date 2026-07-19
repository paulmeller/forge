'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { statusLabel } from '@/lib/status-labels';
import type { TriageHeadline } from '@/lib/triage-view';

import { workOnIssue } from './actions';

const TERMINAL: ReadonlySet<TriageHeadline> = new Set([
  'fixed',
  'not_reproduced',
  'fix_skipped',
  'failed',
]);

export function WorkOnItButton({
  repo,
  issue,
  headline,
}: {
  repo: string;
  issue: { number: number; title: string; body: string; url: string };
  headline: TriageHeadline | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [headline]);

  const inFlight = headline !== null && !TERMINAL.has(headline);
  if (inFlight) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {(headline === 'reproducing' || headline === 'fixing') && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live" aria-hidden />
        )}
        {statusLabel(headline)}
        {headline === 'fix_review' ? ' — check the PR above' : null}
      </p>
    );
  }

  const label = headline === null ? 'Work on it' : 'Work again';

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await workOnIssue(repo, issue);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <Button size="sm" onClick={handleClick} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {label}
      </Button>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
