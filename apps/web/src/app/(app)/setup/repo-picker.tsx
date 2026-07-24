'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
    const result = await syncRepos(installationId, [...checked]);
    if (result?.error) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.refresh();
    setPending(false);
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
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {availableRepos.map((repo) => (
            <label key={repo} className="flex items-center gap-2 text-sm">
              <Checkbox checked={checked.has(repo)} onCheckedChange={() => toggle(repo)} />
              <span className="font-mono">{repo}</span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button onClick={handleSave} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Save selection ({checked.size} selected)
      </Button>
    </div>
  );
}
