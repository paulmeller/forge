'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();

  async function handleSignOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground" title={email}>
        {name}
      </span>
      <Button variant="ghost" size="sm" onClick={handleSignOut} className="h-7 text-xs">
        Sign out
      </Button>
    </div>
  );
}
