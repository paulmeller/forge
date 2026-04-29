'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={`block rounded-md px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      }`}
    >
      {children}
    </Link>
  );
}

export function SessionSidebar({
  userName,
  userEmail,
}: {
  userName: string;
  userEmail: string;
}) {
  const router = useRouter();

  async function handleSignOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-muted/30">
      {/* Top */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Link href="/" className="text-sm font-bold tracking-tight">
          Forge
        </Link>
        <ThemeToggleSmall />
      </div>

      {/* Nav */}
      <div className="px-3 pt-3">
        <NavLink href="/chat">+ New Session</NavLink>
      </div>

      <nav className="mt-4 space-y-0.5 px-3">
        <p className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Navigation
        </p>
        <NavLink href="/chat">Chat</NavLink>
        <NavLink href="/missions">Dashboard</NavLink>
        <NavLink href="/setup">Setup</NavLink>
      </nav>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User */}
      <div className="border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground">
            {userName
              .split(' ')
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{userName}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className="h-6 px-2 text-[11px] text-muted-foreground"
          >
            Sign out
          </Button>
        </div>
      </div>
    </aside>
  );
}

function ThemeToggleSmall() {
  return (
    <button
      onClick={() => {
        const root = document.documentElement;
        const dark = root.classList.contains('dark');
        root.classList.toggle('dark', !dark);
        localStorage.setItem('forge-theme', dark ? 'light' : 'dark');
      }}
      className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Toggle theme"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    </button>
  );
}
