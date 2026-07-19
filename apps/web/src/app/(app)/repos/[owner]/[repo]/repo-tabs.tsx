import { NavTabs } from '@/components/nav-tabs';

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
    <NavTabs
      ariaLabel="Repository sections"
      activeKey={active}
      items={TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        href: tab.key === 'issues' ? `/repos/${repo}` : `/repos/${repo}?tab=${tab.key}`,
      }))}
    />
  );
}
