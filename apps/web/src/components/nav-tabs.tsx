import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Navigation links styled as shadcn Tabs. Use this (not Radix Tabs) when the
 * "tabs" are URL navigation: real anchors keep native ctrl/cmd/middle-click
 * open-in-new-tab and correct semantics (Radix TabsTrigger preventDefaults
 * mousedown with modifiers).
 */
export function NavTabs({
  items,
  activeKey,
  className,
}: {
  items: ReadonlyArray<{ key: string; label: string; href: string }>;
  activeKey: string;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
    >
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.key === activeKey ? 'page' : undefined}
          className={cn(
            'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            item.key === activeKey && 'bg-background text-foreground shadow',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
