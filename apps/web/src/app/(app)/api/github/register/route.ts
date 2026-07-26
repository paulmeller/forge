import { NextResponse } from 'next/server';

import { escapeHtml } from '@/lib/escape-html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub App Manifest flow — Step 1.
 *
 * Redirects to GitHub with a manifest JSON that pre-fills the app config.
 * After the user clicks "Create GitHub App", GitHub redirects to
 * /api/github/register/callback with a code we exchange for credentials.
 *
 * See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * Development-only, and deliberately NOT behind withAuth(). This flow mints
 * the GitHub App that supplies GITHUB_CLIENT_ID/SECRET — the credentials
 * sign-in itself depends on — so requiring a session would deadlock: no app
 * means no login, and no login would mean no way to create the app. Gating on
 * the environment instead keeps bootstrap possible while removing it from the
 * public deployment. Run it locally, then copy the credentials into secrets.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/api/github/register/callback`;

  // GitHub rejects manifests whose hook URL isn't publicly reachable, so
  // skip the webhook entirely when running on localhost.
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  const manifest = {
    name: isLocal ? `forge-local-${Math.random().toString(36).slice(2, 8)}` : 'Forge',
    url: isLocal ? 'https://github.com/paulmeller/forge' : url.origin,
    hook_attributes: isLocal
      ? {
          // Placeholder: localhost isn't accepted, and an inactive hook is never called.
          url: 'https://example.com/forge-local-webhook',
          active: false,
        }
      : {
          url: `${url.origin}/api/forge/github/webhook`,
          active: true,
        },
    redirect_url: callbackUrl,
    callback_urls: [`${url.origin}/api/auth/callback/github`],
    setup_url: `${url.origin}/api/github/callback`,
    setup_on_update: true,
    public: true,
    default_permissions: {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      checks: 'read',
      metadata: 'read',
      // GitHub Apps ignore OAuth scopes — sign-in needs this to read the
      // user's email via /user/emails, or better-auth fails with email_not_found.
      email_addresses: 'read',
    },
    default_events: [
      'issue_comment',
      'check_suite',
      'push',
    ],
  };

  // GitHub manifest flow: POST to /settings/apps/new with a manifest field
  // We use a self-submitting HTML form since it needs to be a POST to GitHub
  const html = `<!DOCTYPE html>
<html>
<body>
  <form id="f" method="post" action="https://github.com/settings/apps/new">
    <input type="hidden" name="manifest" value='${escapeHtml(JSON.stringify(manifest))}' />
  </form>
  <script>document.getElementById('f').submit();</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
