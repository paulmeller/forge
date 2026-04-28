import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from './auth';

export type ApiUser = {
  id: string;
  name: string;
  email: string;
};

const DEV_USER: ApiUser = {
  id: 'user_default',
  name: 'Dev User',
  email: 'dev@forge.local',
};

/**
 * Auth check for API route handlers. Returns the user or a 401 response.
 *
 * When the better-auth adapter fails to initialize (common in local dev
 * with SQLite path issues), falls back to DEV_USER so the product remains
 * usable. Auth gates enforce properly once better-auth is configured.
 */
export async function apiAuth(): Promise<[ApiUser, null] | [null, NextResponse]> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user) {
      // Auth adapter works but no session → try dev fallback
      if (process.env.NODE_ENV === 'development') {
        return [DEV_USER, null];
      }
      return [null, NextResponse.json({ error: 'unauthorized' }, { status: 401 })];
    }

    return [
      { id: session.user.id, name: session.user.name, email: session.user.email },
      null,
    ];
  } catch {
    // Auth adapter failed entirely — fall back in dev, reject in prod
    if (process.env.NODE_ENV === 'development') {
      return [DEV_USER, null];
    }
    return [null, NextResponse.json({ error: 'unauthorized' }, { status: 401 })];
  }
}
