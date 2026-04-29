import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';
import { NextResponse } from 'next/server';

import { githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { getOptionalUser } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub App installation callback.
 *
 * After a user installs the Forge GitHub App, GitHub redirects here with
 * ?installation_id=NNN&setup_action=install.
 *
 * If the user is logged in, we store the installation. If not, we redirect
 * to login with a returnTo URL that preserves the installation_id.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const installationIdStr = url.searchParams.get('installation_id');

  if (!installationIdStr) {
    return NextResponse.redirect(new URL('/setup', url.origin));
  }

  const installationId = Number(installationIdStr);

  const user = await getOptionalUser();
  if (!user) {
    // Redirect to login, preserving the installation_id
    const returnTo = `/api/github/callback?installation_id=${installationId}`;
    return NextResponse.redirect(
      new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin),
    );
  }

  // Check if this installation already exists
  const [existing] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  if (existing) {
    // Already stored — redirect to setup
    return NextResponse.redirect(new URL('/setup', url.origin));
  }

  // Fetch installation details from GitHub API
  // For now, store with placeholder values — the setup page can populate details
  const id = `ghi_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const now = new Date();

  await db.insert(githubInstallations).values({
    id,
    userId: user.id,
    installationId,
    accountLogin: user.name ?? user.email,
    accountType: 'User',
    createdAt: now,
    updatedAt: now,
  });

  return NextResponse.redirect(new URL('/setup', url.origin));
}
