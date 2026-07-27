import Link from 'next/link';
import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader, PageShell } from '@/components/page-shell';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { createInstallationAccessToken, listInstallationRepositories } from '@/lib/github-app-auth';
import { withAuth } from '@/lib/with-auth';

import { RepoPicker } from './repo-picker';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await withAuth();
  const { error } = await searchParams;

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

  const step = !installation ? 1 : connectedRepos.length === 0 ? 2 : 3;

  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />

      {error === 'install_not_verified' && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle className="text-sm">Install wasn&rsquo;t linked</AlertTitle>
          <AlertDescription className="text-xs">
            We couldn&rsquo;t confirm with GitHub that this installation belongs to your account,
            so it wasn&rsquo;t linked. If you installed on an organisation, check that you still
            have access to it on GitHub, then start again with the button below.
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-6 flex items-center">
        {[
          { n: 1, label: 'Install' },
          { n: 2, label: 'Select repos' },
          { n: 3, label: 'Try it' },
        ].map((s, i, arr) => (
          <div key={s.n} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
                  (step > s.n
                    ? 'bg-live/15 text-live'
                    : step === s.n
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground')
                }
              >
                {step > s.n ? '✓' : s.n}
              </span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            {i < arr.length - 1 ? <div className="mx-3 h-px flex-1 bg-border" /> : null}
          </div>
        ))}
      </div>

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
                // Goes via our own route so it can mint a one-time state
                // cookie before bouncing to GitHub — see api/github/install.
                href="/api/github/install"
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
