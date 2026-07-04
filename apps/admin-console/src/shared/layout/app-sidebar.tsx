'use client';

import { IconHeartRateMonitor } from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from '@arcaai/ui/components/shadcn/sidebar';
import { usePermissions } from '@/shared/auth/hooks';
import { NAV_SECTIONS, visibleNavEntries } from '@/shared/navigation/nav-config';

/**
 * Ability-driven navigation: sections and entries render only when
 * POST /rbac/check/my-permissions grants them (and the screen exists —
 * unimplemented routes stay hidden behind the design gate).
 */
export function AppSidebar() {
    const pathname = usePathname();
    const { data: rules } = usePermissions();
    const entries = visibleNavEntries(rules);

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild>
                            <Link href="/dashboard">
                                <IconHeartRateMonitor className="size-5" />
                                <span className="text-base font-semibold">HOPE Admin</span>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                {NAV_SECTIONS.map((section) => {
                    const sectionEntries = entries.filter((entry) => entry.tier === section.tier);
                    if (sectionEntries.length === 0) return null;
                    return (
                        <SidebarGroup key={section.tier}>
                            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {sectionEntries.map((entry) => (
                                        <SidebarMenuItem key={entry.route}>
                                            <SidebarMenuButton asChild isActive={pathname === entry.route || pathname.startsWith(`${entry.route}/`)}>
                                                <Link href={entry.route}>
                                                    <span>{entry.label}</span>
                                                </Link>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    );
                })}
            </SidebarContent>
            <SidebarRail />
        </Sidebar>
    );
}
