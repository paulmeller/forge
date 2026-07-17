'use client';

import Link from 'next/link';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
    <Tabs value={active} className="mb-4">
      <TabsList>
        {TABS.map((tab) => {
          const href =
            tab.key === 'issues' ? `/repos/${repo}` : `/repos/${repo}?tab=${tab.key}`;
          return (
            <TabsTrigger key={tab.key} value={tab.key} asChild>
              <Link href={href}>{tab.label}</Link>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
