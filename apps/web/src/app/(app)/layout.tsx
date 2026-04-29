import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import { getOptionalUser } from '@/lib/with-auth';
import { SessionSidebar } from '@/components/session-sidebar';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getOptionalUser();

  // Pages that need the old full-width layout (login, signup, setup)
  // get it via the children prop — the sidebar is always present for
  // authenticated users.
  if (!user) {
    return (
      <>
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
          <div className="container flex h-12 max-w-[1400px] items-center justify-between">
            <Link href="/" className="text-sm font-bold tracking-tight">
              Forge
            </Link>
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>
        {children}
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <SessionSidebar userName={user.name} userEmail={user.email} />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
