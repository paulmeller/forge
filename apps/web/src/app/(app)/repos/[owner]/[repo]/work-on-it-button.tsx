'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { TriageHeadline } from '@/lib/triage-view';

import { workOnIssue } from './actions';

const TERMINAL: ReadonlySet<TriageHeadline> = new Set([
  'fixed',
  'not_reproduced',
  'fix_skipped',
  'failed',
]);

const IN_FLIGHT_LABEL: Record<string, string> = {
  reproducing: 'Reproducing…',
  fixing: 'Fixing…',
  fix_review: 'Awaiting review',
};

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

  const inFlight = headline !== null && !TERMINAL.has(headline);
  if (inFlight) {
    return (
      <Button disabled variant="secondary" size="sm">
        {IN_FLIGHT_LABEL[headline] ?? 'In progress'}
      </Button>
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
        {pending ? 'Queuing…' : label}
      </Button>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
