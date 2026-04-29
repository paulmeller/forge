import Link from 'next/link';
import { eq } from '@forge/db/orm';

import { githubInstallations, githubInstallationRepos } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

import { RepoSelector } from './repo-selector';

export default async function SetupPage() {
  const user = await withAuth();

  const installations = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id));

  const installation = installations[0];

  // No installation yet — show install button
  if (!installation) {
    return (
      <main className="mx-auto max-w-lg px-6 py-20">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Connect your repos
        </h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Install the Forge GitHub App to connect your repositories. Webhooks
          are configured automatically — no manual setup needed.
        </p>
        <a
          href={`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`}
          className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <svg className="mr-2 h-5 w-5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
          Install Forge on GitHub
        </a>
        <p className="mt-6 text-xs text-muted-foreground">
          After installing, you&rsquo;ll be redirected back here to select repos.
        </p>
      </main>
    );
  }

  // Installation exists — check for connected repos
  const repos = await db
    .select()
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.installationId, installation.id));

  if (repos.length > 0) {
    return (
      <main className="mx-auto max-w-lg px-6 py-20">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          You&rsquo;re all set
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {repos.length} repo{repos.length !== 1 ? 's' : ''} connected via{' '}
          <span className="font-medium text-foreground">{installation.accountLogin}</span>.
          Comment <code className="rounded bg-muted px-1 py-0.5 text-xs">@forge</code>{' '}
          on any issue to get started.
        </p>
        <div className="mb-8 space-y-1">
          {repos.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-sm">
              <span className="text-green-500">*</span>
              <span>{r.repo}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <Link
            href="/missions"
            className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to Dashboard
          </Link>
          <a
            href={`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`}
            className="inline-flex items-center rounded-md border px-5 py-2.5 text-sm transition-colors hover:bg-accent"
          >
            Add more repos
          </a>
        </div>
      </main>
    );
  }

  // Installation exists but no repos selected — show selector
  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">
        Select repos
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Choose which repositories Forge can work on. You can change this later.
      </p>
      <RepoSelector installationId={installation.id} />
    </main>
  );
}
