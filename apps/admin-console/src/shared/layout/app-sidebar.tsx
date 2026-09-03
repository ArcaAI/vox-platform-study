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
  useSidebar,
} from '@arcaai/ui/components/shadcn/sidebar';
import { usePermissions, useSession } from '@/shared/auth/hooks';
import { activeNavDomainId, matchNavEntry, NAV_SECTIONS, visibleNavDomains, visibleNavEntries } from '@/shared/navigation/nav-config';
import { DomainRail } from './domain-rail';
import { rovingItemProps, useRovingFocus } from './use-roving-focus';

/**
 * Tier two of the two-tier shell: the scoped sidebar. It renders
 * ONLY the routes of the domain the current URL belongs to — 3 to 10 entries
 * instead of the 56-entry flat list that made `collapsible="icon"` a wall of
 * unlabelled icons.
 *
 * Three properties are load-bearing:
 *
 * - **Selection is derived.** `activeNavDomainId(pathname, …)` is the only
 *   input; there is no domain state to drift out of sync with the URL (AC-6).
 * - **Ability gating goes through `visibleNavEntries`** — the same function the
 *   rail, the ⌘K palette and the user menu use. There is exactly one ability
 *   path in the console, so a domain can never advertise a route its owner
 *   cannot open (AC-3).
 * - **Tier sub-headers survive.** `NAV_SECTIONS` still groups entries *within*
 *   a domain, because tier tells a super admin which rows are cross-tenant.
 *   Domain and tier are orthogonal and both are visible.
 *
 * Collapse is `offcanvas`, not `icon`: with a permanent domain rail alongside,
 * an icon-collapsed sidebar would be a second column of unlabelled icons —
 * the exact defect this ticket removes. Collapsed now means "rail only".
 */
export function AppSidebar() {
  const pathname = usePathname();
  const { data: rules } = usePermissions();
  const { data: session } = useSession();
  const { isMobile } = useSidebar();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>('vertical');

  const entries = visibleNavEntries(rules, session?.user.roles);
  const domains = visibleNavDomains(rules, session?.user.roles);
  const activeEntry = matchNavEntry(pathname, entries);
  // A route no domain owns (`/account`, `/developer`, a 404) still gets a
  // frame: the first domain the caller can reach, with nothing selected.
  const activeDomainId = activeNavDomainId(pathname, entries) ?? domains[0]?.id;
  const activeDomain = domains.find((domain) => domain.id === activeDomainId);
  const domainEntries = entries.filter((entry) => entry.domain === activeDomainId);

  // Tier sub-headers only earn their space when the domain actually spans more
  // than one tier (AI Platform and Platform Ops do; Clinical does not).
  const tierCount = new Set(domainEntries.map((entry) => entry.tier)).size;
  // Exactly one tab stop for the whole list (AC-8).
  const tabStopRoute = domainEntries.find((entry) => entry === activeEntry)?.route ?? domainEntries[0]?.route;

  return (
    // `md:translate-x-14` clears the 56px rail. A transform is used rather
    // than a `left` override because the primitive's own collapse rule is a
    // `left` calc — a second `left` utility would race it in the cascade.
    <Sidebar collapsible="offcanvas" className="md:translate-x-14">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <div aria-hidden className="flex size-8 shrink-0 items-center justify-center">
                  <IconHeartRateMonitor className="size-5" />
                </div>
                <span className="truncate text-base font-medium">HOPE Admin</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Below `md` the rail has no column of its own, so the domain switcher
            travels into this off-canvas sheet with the scoped list (AC-7). */}
        {isMobile ? <DomainRail variant="inline" /> : null}
      </SidebarHeader>
      <SidebarContent ref={containerRef} onKeyDown={onKeyDown} role="navigation" aria-label={activeDomain ? `${activeDomain.label} navigation` : 'Main'}>
        {NAV_SECTIONS.map((section) => {
          const sectionEntries = domainEntries.filter((entry) => entry.tier === section.tier);
          if (sectionEntries.length === 0) return null;
          return (
            <SidebarGroup key={section.tier}>
              <SidebarGroupLabel>{tierCount > 1 ? section.label : (activeDomain?.label ?? section.label)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {sectionEntries.map((entry) => {
                    const Icon = entry.icon;
                    const isCurrent = pathname === entry.route;
                    const isActive = entry === activeEntry;
                    return (
                      <SidebarMenuItem key={entry.route} className="relative">
                        {/*
 Third state signal (AC-5). `SidebarMenuButton`'s own
                            `data-[active=true]` classes supply the other two —
                            the --sidebar-accent fill and font-medium — and the
                            fill alone is 1.14:1 on --sidebar (globals.css
                            J-11), so it can never stand by itself.
*/}
                        {isActive ? <span aria-hidden className="bg-foreground absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2" /> : null}
                        <SidebarMenuButton asChild isActive={isActive}>
                          <Link
                            href={entry.route}
                            aria-current={isCurrent ? 'page' : undefined}
                            {...rovingItemProps(entry.route === tabStopRoute)}
                          >
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
