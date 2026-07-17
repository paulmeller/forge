import Link from 'next/link';

import { ForgeSidebar } from '@/components/forge-sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { getOptionalUser } from '@/lib/with-auth';

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
    <SidebarProvider>
      <ForgeSidebar userName={user.name} userEmail={user.email} />
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
