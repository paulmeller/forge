import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import { getOptionalUser } from '@/lib/with-auth';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getOptionalUser();

  return (
    <>
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-12 max-w-[1400px] items-center justify-between">
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-sm font-bold tracking-tight">
              Forge
            </Link>
            <Link
              href="/missions"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Missions
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <UserMenu name={user.name} email={user.email} />
            ) : (
              <Link
                href="/login"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
