import { NextResponse } from 'next/server';

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
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/api/github/register/callback`;

  const manifest = {
    name: 'Forge',
    url: url.origin,
    hook_attributes: {
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
      issues: 'read',
      pull_requests: 'write',
      checks: 'read',
      metadata: 'read',
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
    <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}' />
  </form>
  <script>document.getElementById('f').submit();</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}
