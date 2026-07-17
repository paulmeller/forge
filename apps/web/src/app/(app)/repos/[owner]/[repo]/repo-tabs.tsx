'use client';

import Link from 'next/link';

const TABS = [
  { key: 'issues', label: 'Issues' },
  { key: 'activity', label: 'Activity' },
  { key: 'settings', label: 'Settings' },
] as const;

export function RepoTabs({
  active,
  repo,
}: {
  active: 'issues' | 'activity' | 'settings';
  repo: string;
}) {
  return (
    <div className="mb-4 flex gap-1 border-b">
      {TABS.map((tab) => {
        const href =
          tab.key === 'issues' ? `/repos/${repo}` : `/repos/${repo}?tab=${tab.key}`;
        return (
          <Link
            key={tab.key}
            href={href}
            className={`px-3 py-2 text-sm font-medium ${
              active === tab.key
                ? 'border-b-2 border-[color:var(--forge-accent-to)] text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
