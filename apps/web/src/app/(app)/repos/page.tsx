import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { PageHeader, PageShell } from '@/components/page-shell';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const user = await withAuth();
  const repos = await listUserRepos(user.id);

  return (
    <PageShell className="max-w-3xl">
      <PageHeader
        title="Repos"
        subtitle="Pick a repo to see its open issues and work on them one at a time."
      />

      {repos.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No repos connected yet.</EmptyTitle>
            <EmptyDescription>
              <Link href="/setup">Connect repos in Setup</Link>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
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
    </PageShell>
  );
}
