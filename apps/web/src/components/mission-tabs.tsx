'use client';

import { usePathname } from 'next/navigation';

import { NavTabs } from '@/components/nav-tabs';

type TabKey = 'overview' | 'pipeline' | 'tools' | 'tasks';

const TABS: Array<{ key: TabKey; label: string; disabled: boolean }> = [
  { key: 'overview', label: 'Overview', disabled: false },
  { key: 'pipeline', label: 'Pipeline', disabled: true },
  { key: 'tools', label: 'Tools', disabled: true },
  { key: 'tasks', label: 'Tasks', disabled: true },
];

function tabHref(missionId: string, key: TabKey): string {
  return key === 'overview' ? `/missions/${missionId}` : `/missions/${missionId}/${key}`;
}

/**
 * Which tab (if any) a given pathname belongs to. Overview matches only the
 * exact mission root — a prefix match would also light it up for /ledger,
 * /plan, /retrospective, /issues, which are separate, un-tabbed routes.
 * The other three match by prefix so nested sub-paths (e.g. a future
 * /tasks/[taskId]) still highlight their parent tab.
 */
export function activeMissionTab(pathname: string, missionId: string): TabKey | null {
  const overviewHref = tabHref(missionId, 'overview');
  if (pathname === overviewHref) return 'overview';
  for (const tab of TABS) {
    if (tab.key === 'overview') continue;
    if (pathname.startsWith(tabHref(missionId, tab.key))) return tab.key;
  }
  return null;
}

export function MissionTabs({ missionId }: { missionId: string }) {
  const pathname = usePathname();
  const active = activeMissionTab(pathname, missionId);

  return (
    <NavTabs
      ariaLabel="Mission sections"
      activeKey={active ?? ''}
      items={TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        href: tabHref(missionId, tab.key),
        disabled: tab.disabled,
      }))}
    />
  );
}
