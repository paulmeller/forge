import { PageHeader, PageShell } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import { listActiveSessions } from '@/lib/sessions';
import { withAuth } from '@/lib/with-auth';

import { SessionRowForm } from './session-row-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Active sessions',
};

/**
 * Every live session in your account, and a way to end any of them.
 *
 * This is the page that makes a device authorization reversible. `/device/token`
 * issues an ordinary session, so a CLI you authorized — or one you were talked
 * into authorizing, which the consent screen cannot rule out — is one row here,
 * and signing it out ends its access immediately.
 *
 * A session created by the device flow carries the IP and user agent of the
 * CLI that exchanged the code, not of the browser that approved it, which is
 * usually how you tell them apart. Forge does not label them beyond that:
 * better-auth's `session` table has no column to record how a session was
 * created, and adding one would be a schema migration for a label. If a row's
 * details are not ones you recognise, sign it out — that is the safe action in
 * either case.
 */
export default async function SessionsPage() {
  await withAuth();

  const sessions = await listActiveSessions();

  return (
    <PageShell className="max-w-3xl py-10">
      <PageHeader
        title="Active sessions"
        subtitle="Everything currently signed in to your account, including command-line tools you authorized from a device code."
      />

      <Alert className="mb-6">
        <AlertTitle>Sign out anything you do not recognise</AlertTitle>
        <AlertDescription>
          Every session here can do anything you can. Authorizing a device grants exactly this —
          there are no reduced-permission tokens — so if you were asked to enter a device code by
          someone else, or you no longer use a tool listed here, sign it out.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3">
        {sessions.map((session) => (
          <Card key={session.id}>
            <CardContent className="flex items-start justify-between gap-4 py-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {session.userAgent ?? 'Unknown client'}
                  </span>
                  {session.current ? <Badge variant="secondary">This device</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {session.ipAddress ? `${session.ipAddress} · ` : ''}
                  Signed in {session.createdAt ? formatDateTime(session.createdAt) : 'at an unknown time'}
                  {session.expiresAt ? ` · expires ${formatDateTime(session.expiresAt)}` : ''}
                </p>
              </div>
              {session.current ? (
                <p className="text-xs text-muted-foreground">Use Sign out to end this one.</p>
              ) : (
                <SessionRowForm sessionId={session.id} />
              )}
            </CardContent>
          </Card>
        ))}
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : null}
      </div>
    </PageShell>
  );
}
