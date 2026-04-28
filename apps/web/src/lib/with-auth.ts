import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from './auth';

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
};

/**
 * Server-side auth check. Returns the current user or redirects to /login.
 * Use in server components and server actions.
 */
export async function withAuth(): Promise<CurrentUser> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    redirect('/login');
  }

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}

/**
 * Optional auth check — returns user or null without redirecting.
 */
export async function getOptionalUser(): Promise<CurrentUser | null> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    if (!session?.user) return null;
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    };
  } catch {
    return null;
  }
}
