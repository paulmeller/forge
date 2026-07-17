'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import { connectRepos } from './actions';

export function RepoSelector({ installationId }: { installationId: string }) {
  const router = useRouter();
  const [repos, setRepos] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const repoList = repos
      .split(/[\n,]+/)
      .map((r) => r.trim())
      .filter(Boolean);

    if (repoList.length === 0) {
      setError('Enter at least one repo (e.g. owner/repo)');
      return;
    }

    const invalid = repoList.find((r) => !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(r));
    if (invalid) {
      setError(`Invalid repo format: ${invalid}. Use owner/repo.`);
      return;
    }

    setPending(true);
    const result = await connectRepos(installationId, repoList);
    if (result?.error) {
      setError(result.error);
      setPending(false);
      return;
    }

    router.push('/missions');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Textarea
          placeholder={'owner/repo\nowner/another-repo'}
          rows={6}
          className="font-mono text-sm"
          value={repos}
          onChange={(e) => setRepos(e.target.value)}
          autoFocus
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Enter repository names like <code>acme/api</code>, one per line or comma-separated.
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Connect repos
      </Button>
    </form>
  );
}
