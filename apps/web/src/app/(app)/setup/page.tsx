import Link from 'next/link';
import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { PageHeader, PageShell } from '@/components/page-shell';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { createInstallationAccessToken, listInstallationRepositories } from '@/lib/github-app-auth';
import { withAuth } from '@/lib/with-auth';

import { RepoPicker } from './repo-picker';

export default async function SetupPage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id));

  let ghRepos: string[] | null = null;
  let connectedRepos: string[] = [];

  if (installation) {
    const rows = await db
      .select()
      .from(githubInstallationRepos)
      .where(eq(githubInstallationRepos.installationId, installation.id));
    connectedRepos = rows.map((r) => r.repo);

    // Same env vars and guard github-installation-sync.ts already uses for
    // this exact create-token-then-list-repos flow — wrapped in try/catch
    // here (unlike that file) so a failure degrades the page gracefully
    // instead of throwing.
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const token = await createInstallationAccessToken(
          installation.installationId,
          env.GITHUB_APP_ID,
          env.GITHUB_APP_PRIVATE_KEY,
        );
        ghRepos = await listInstallationRepositories(token);
      } catch {
        ghRepos = null;
      }
    }
  }

  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />

      <div className="flex flex-col gap-4">
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {installation ? (
                  <span className="text-live">&#10003;</span>
                ) : (
                  <span className="text-muted-foreground">1.</span>
                )}{' '}
                Install the Forge GitHub App
              </p>
              {installation && (
                <p className="mt-1 text-xs text-muted-foreground">{installation.accountLogin}</p>
              )}
            </div>
            {!installation && (
              <a
                href={`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`}
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Install on GitHub
              </a>
            )}
          </div>
        </div>

        <div className={`rounded-lg border p-4 ${!installation ? 'opacity-40' : ''}`}>
          <p className="mb-3 text-sm font-medium">2. Select repos</p>
          {installation ? (
            <RepoPicker
              installationId={installation.id}
              ghRepos={ghRepos}
              connectedRepos={connectedRepos}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Complete step 1 first.</p>
          )}
        </div>

        <div className={`rounded-lg border p-4 ${connectedRepos.length === 0 ? 'opacity-40' : ''}`}>
          <p className="text-sm font-medium">3. Try it</p>
          {connectedRepos.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Comment <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue in a
              connected repo, or{' '}
              <Link href="/missions/new" className="underline hover:text-foreground">
                start a mission manually
              </Link>
              .
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Select at least one repo first.</p>
          )}
        </div>
      </div>
    </PageShell>
  );
}
