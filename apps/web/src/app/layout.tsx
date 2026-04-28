import type { Metadata } from 'next';
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import { getOptionalUser } from '@/lib/with-auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Forge',
  description: 'Open-source Missions for Claude Managed Agents.',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getOptionalUser();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Prevent FOUC: apply stored theme before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('forge-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
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
      </body>
    </html>
  );
}
