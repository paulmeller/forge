import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const user = await withAuth();
  const repos = await listUserRepos(user.id);

  return (
    <main className="container max-w-3xl py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a repo to see its open issues and work on them one at a time.
        </p>
      </div>

      {repos.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No repos connected yet.{' '}
          <Link href="/setup" className="underline underline-offset-2">
            Connect repos in Setup
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-2">
          {repos.map((repo) => {
            const [owner, name] = repo.split('/');
            return (
              <Link
                key={repo}
                href={`/repos/${owner}/${name}`}
                className="block rounded-lg border p-4 font-mono text-sm transition-colors hover:bg-accent"
              >
                {repo}
              </Link>
            );
          })}
          <Button asChild variant="ghost" size="sm" className="mt-2">
            <Link href="/setup">Connect more repos</Link>
          </Button>
        </div>
      )}
    </main>
  );
}
