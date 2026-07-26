import { NextResponse } from 'next/server';

import { escapeHtml } from '@/lib/escape-html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub App Manifest flow — Step 2.
 *
 * After the user creates the app on GitHub, we get redirected here
 * with ?code=xxx. Exchange it for the app credentials.
 *
 * Development-only for the same reason as step 1 (see ../route.ts): this is
 * pre-login bootstrap, so it cannot require a session, and an unauthenticated
 * endpoint that renders a private key has no business on a public deployment.
 * `code` is attacker-suppliable, so every field of the resulting response is
 * treated as untrusted and escaped on the way into the HTML.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  // Exchange the code for app credentials
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: 'Failed to create app', details: body }, { status: 500 });
  }

  const app = await res.json();

  // Display the credentials — the user needs to save these as env vars / secrets
  const html = `<!DOCTYPE html>
<html>
<head><title>Forge GitHub App Created</title>
<style>
  body { font-family: system-ui; max-width: 640px; margin: 40px auto; padding: 0 20px; background: #09090b; color: #fafafa; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #71717a; font-size: 14px; }
  pre { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 12px; line-height: 1.6; }
  code { color: #22c55e; }
  .warn { color: #f59e0b; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
  <h1>Forge GitHub App Created</h1>
  <p>App <strong>${escapeHtml(app.name)}</strong> (ID: ${escapeHtml(app.id)}) is ready. Save these credentials:</p>
  <pre><code># Add to .env.local or Cloud Run secrets
GITHUB_APP_ID=${escapeHtml(app.id)}
GITHUB_APP_SLUG=${escapeHtml(app.slug)}
GITHUB_CLIENT_ID=${escapeHtml(app.client_id)}
GITHUB_CLIENT_SECRET=${escapeHtml(app.client_secret)}
GITHUB_APP_PRIVATE_KEY="${escapeHtml(app.pem?.replace(/\n/g, '\\n'))}"
GITHUB_WEBHOOK_SECRET=${escapeHtml(app.webhook_secret)}</code></pre>
  <p class="warn">Save the private key now — GitHub won't show it again.</p>
  <p>Next: <a href="/setup" style="color: #3b82f6;">Go to Setup</a> to install the app on your repos.</p>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html',
      // This body carries a private key and two secrets. Without no-store the
      // browser's disk cache (and any intermediary) is free to persist them.
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
