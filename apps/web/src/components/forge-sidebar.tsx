'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderGit2, Home, MessageSquare, Rocket, Settings, SquarePen } from 'lucide-react';

import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

const NAV_ITEMS = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/repos', label: 'Repos', icon: FolderGit2 },
  { href: '/missions', label: 'Missions', icon: Rocket },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/setup', label: 'Setup', icon: Settings },
] as const;

export function ForgeSidebar({ userName, userEmail }: { userName: string; userEmail: string }) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/home">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <span className="text-sm font-bold">F</span>
                </div>
                <span className="truncate text-sm font-bold tracking-tight">Forge</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="New Session">
                <Link href="/chat">
                  <SquarePen />
                  <span>New Session</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton asChild isActive={pathname === href} tooltip={label}>
                  <Link href={href}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser name={userName} email={userEmail} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
