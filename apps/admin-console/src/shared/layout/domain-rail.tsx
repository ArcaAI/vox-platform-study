'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@arcaai/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@arcaai/ui/components/shadcn/tooltip';
import { useSidebar } from '@arcaai/ui/components/shadcn/sidebar';
import { usePermissions, useSession } from '@/shared/auth/hooks';
import { activeNavDomainId, domainLandingRoute, visibleNavDomains, visibleNavEntries } from '@/shared/navigation/nav-config';
import { rovingItemProps, useRovingFocus } from './use-roving-focus';

/**
 * The 56px capability-domain rail (/OD-2) — tier one of the
 * two-tier shell that replaced a single 56-entry `collapsible="icon"` sidebar.
 *
 * Geometry follows Geometry Contract: 36px (`size-9`) items with
 * `rounded-control`, 8px padding (`p-2`) inside a 56px (`w-14`) column. The
 * contract's 12px surface radius applies to the `inline` (mobile) variant,
 * which IS a floating panel; the desktop rail is full-bleed against the
 * viewport edge to match the adjacent `variant="sidebar"` shell, so it has no
 * radius to carry.
 *
 * Selection is DERIVED from `usePathname()` (AC-6). There is no domain state
 * anywhere in this component tree — no `useState`, no localStorage, no click
 * handler that records a choice. Every item is a real `<Link>`, so the URL
 * changes on every activation and the back button works.
 */
export function DomainRail({ variant = 'rail' }: { variant?: 'rail' | 'inline' }) {
  const pathname = usePathname();
  const { data: rules } = usePermissions();
  const { data: session } = useSession();
  const { isMobile, setOpenMobile } = useSidebar();

  const entries = visibleNavEntries(rules, session?.user.roles);
  const domains = visibleNavDomains(rules, session?.user.roles);
  const activeId = activeNavDomainId(pathname, entries);

  const isInline = variant === 'inline';
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>(isInline ? 'horizontal' : 'vertical');

  // The desktop rail is chrome for the md+ layout only; below `md` the whole
  // navigation moves into the sidebar's off-canvas sheet, where the `inline`
  // variant renders instead (AC-7). Dropping it from the DOM (rather than only
  // hiding it) keeps a single `Domains` landmark in the a11y tree.
  if (!isInline && isMobile) return null;
  if (domains.length === 0) return null;

  // Exactly one tab stop for the whole rail (AC-8).
  const tabStopId = domains.find((domain) => domain.id === activeId)?.id ?? domains[0]?.id;

  return (
    <nav
      aria-label="Capability domains"
      className={cn(
        isInline
          ? 'bg-sidebar rounded-surface border-sidebar-border shrink-0 border p-2'
          : 'bg-sidebar border-sidebar-border relative z-chrome hidden h-svh w-14 shrink-0 flex-col border-r p-2 md:flex',
      )}
    >
      <ul
        ref={containerRef}
        onKeyDown={onKeyDown}
        className={cn('flex gap-1', isInline ? 'flex-row overflow-x-auto' : 'min-h-0 flex-1 flex-col items-center overflow-y-auto')}
      >
        {domains.map((domain) => {
          const Icon = domain.icon;
          const isActive = domain.id === activeId;
          // Rail clicks always navigate — to the domain's first visible route.
          // A domain with exactly one visible entry needs no special case: the
          // general rule already lands on it (see `domainLandingRoute`).
          const href = domainLandingRoute(domain.id, entries);
          if (!href) return null;

          return (
            <li key={domain.id} className={cn('relative shrink-0', isInline ? '' : 'flex justify-center')}>
              {/*
 Signal 2 of 2 for the rail: a 2px --foreground rule. The fill
                  below cannot carry the state alone — under this achromatic
                  palette --sidebar-accent is 1.14:1 on --sidebar in light and
                  1.34:1 in dark (globals.css, J-11).
*/}
              {isActive ? (
                <span
                  aria-hidden
                  className={cn(
                    'bg-foreground absolute',
                    isInline ? 'inset-x-1 bottom-0 h-0.5' : 'top-1/2 left-0 h-9 w-0.5 -translate-y-1/2',
                  )}
                />
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={href}
                    aria-current={isActive ? 'true' : undefined}
                    data-active={isActive}
                    onClick={() => isInline && setOpenMobile(false)}
                    {...rovingItemProps(domain.id === tabStopId)}
                    className={cn(
                      'rounded-control focus-visible:ring-sidebar-ring flex items-center outline-none focus-visible:ring-2',
                      'transition-colors duration-fast motion-reduce:transition-none',
                      isInline ? 'h-9 gap-2 px-3 text-sm' : 'size-9 justify-center',
                      isActive
                        ? // Signal 1 of 2: fill. Signal 3 (font-medium) only
                          // reads where there is visible text.
                          'bg-sidebar-accent text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    {/* AC-4: every rail item carries an accessible name. The
                        icon-only variant exposes it to assistive tech and to
                        sighted users through the tooltip. */}
                    <span className={cn(isInline ? 'truncate' : 'sr-only')}>{domain.label}</span>
                  </Link>
                </TooltipTrigger>
                {isInline ? null : (
                  <TooltipContent side="right" sideOffset={8}>
                    {domain.label}
                  </TooltipContent>
                )}
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
