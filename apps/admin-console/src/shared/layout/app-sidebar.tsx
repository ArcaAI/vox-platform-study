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
 *
 * Collapsible to an icon-only rail (`collapsible="icon"`): every entry leads
 * with its unique nav-config icon, labels collapse away, tooltips take over,
 * and the rail keeps scrolling on short viewports.
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
                        <SidebarMenuButton size="lg" tooltip="HOPE Admin" asChild>
                            <Link href="/dashboard">
                                {/* Fixed square keeps the brand mark centered in the collapsed rail. */}
                                <div aria-hidden className="flex size-8 shrink-0 items-center justify-center">
                                    <IconHeartRateMonitor className="size-5" />
                                </div>
                                <span className="truncate text-base font-semibold">HOPE Admin</span>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent role="navigation" aria-label="Main">
                {NAV_SECTIONS.map((section) => {
                    const sectionEntries = entries.filter((entry) => entry.tier === section.tier);
                    if (sectionEntries.length === 0) return null;
                    return (
                        <SidebarGroup key={section.tier}>
                            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {sectionEntries.map((entry) => {
                                        const Icon = entry.icon;
                                        const isCurrent = pathname === entry.route;
                                        return (
                                            <SidebarMenuItem key={entry.route}>
                                                <SidebarMenuButton
                                                    asChild
                                                    tooltip={entry.label}
                                                    isActive={isCurrent || pathname.startsWith(`${entry.route}/`)}
                                                >
                                                    <Link href={entry.route} aria-current={isCurrent ? 'page' : undefined}>
                                                        <Icon aria-hidden />
                                                        <span>{entry.label}</span>
                                                    </Link>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        );
                                    })}
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
