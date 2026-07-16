import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';
import { NextResponse } from 'next/server';

import { githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { syncGithubInstallation } from '@/lib/github-installation-sync';
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

  let installationRowId: string;
  if (existing) {
    // Already stored — re-sync in case grants changed (e.g. "Add more repos")
    installationRowId = existing.id;
  } else {
    // Store with placeholder account details; syncGithubInstallation below
    // corrects them from GitHub's own installation record.
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
    installationRowId = id;
  }

  try {
    await syncGithubInstallation(installationRowId);
  } catch (err) {
    // Don't block the redirect — Setup's manual repo entry remains a
    // fallback if the GitHub sync fails (e.g. misconfigured App credentials).
    console.error('syncGithubInstallation failed', err);
  }

  return NextResponse.redirect(new URL('/setup', url.origin));
}
