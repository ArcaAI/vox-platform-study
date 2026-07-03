import { Link, useMatches } from '@tanstack/react-router';
import { ChevronRight, House } from 'lucide-react';
import { Fragment } from 'react';
import { NAV_ITEMS } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

/** Label is either literal text or resolved from the tenant-detail store. */
type CrumbLabel = string | { from: 'tenant' | 'department' | 'user' };

export interface CrumbItem {
  label: CrumbLabel;
  /** `undefined` → link to the match's own pathname · `null` → non-link group label · string → explicit href. */
  to?: string | null;
}

/** Value of `staticData.crumb` on a route (TASK-379 breadcrumb model, README §5.12). */
export type CrumbConfig = string | CrumbItem | CrumbItem[];

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    crumb?: CrumbConfig;
  }
}

interface ResolvedCrumb {
  label: string;
  href?: string;
}

function activeNavTitle(pathname: string): string | null {
  // Longest-prefix match so `/tenants/abc` resolves to the Tenants item.
  let best: { to: string; label: string } | null = null;
  for (const item of NAV_ITEMS) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = { to: item.to, label: item.label };
    }
  }
  return best?.label ?? null;
}

/**
 * Topbar breadcrumb (TASK-371 §5.12) built from `useMatches()` + each route's
 * `staticData.crumb`. Dynamic labels (`{ from: 'tenant' | 'department' }`) resolve
 * from the tenant-detail store. The active in-page tab is intentionally NOT
 * appended (the tab nav shows it). Non-tenant pages fall back to `Home / «Title»`.
 */
export function Breadcrumbs() {
  const matches = useMatches();
  const tenant = useTenantDetailStore((s) => s.tenant);
  const department = useTenantDetailStore((s) => s.department);
  const user = useTenantDetailStore((s) => s.user);

  const crumbs: ResolvedCrumb[] = [{ label: 'Home', href: '/' }];

  for (const match of matches) {
    const raw = match.staticData?.crumb;
    if (!raw) continue;
    const items: CrumbItem[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [{ label: raw }] : [raw];
    const params = (match.params ?? {}) as Record<string, string>;
    for (const item of items) {
      const label =
        typeof item.label === 'string'
          ? item.label
          : item.label.from === 'tenant'
            ? (tenant?.name ?? '…')
            : item.label.from === 'department'
              ? (department?.name ?? '…')
              : (user?.username ?? '…');
      // Resolve `$param` tokens in an explicit href from the match params;
      // `match.pathname` is already concrete so the replace is a no-op there.
      const template = item.to === null ? undefined : (item.to ?? match.pathname);
      const href = template?.replace(/\$([A-Za-z0-9_]+)/g, (_, key: string) => params[key] ?? '');
      crumbs.push({ label, href });
    }
  }

  // Fallback for pages without explicit crumbs: Home / <active nav title>.
  if (crumbs.length === 1) {
    const last = matches[matches.length - 1];
    const title = last ? activeNavTitle(last.pathname) : null;
    if (title) crumbs.push({ label: title, href: undefined });
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          const isHome = index === 0;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" /> : null}
              {isLast || !crumb.href ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={cn('truncate', isLast ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                >
                  {isHome ? <House aria-label="Home" className="size-4" /> : crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.href}
                  className="truncate rounded text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {isHome ? <House aria-label="Home" className="size-4" /> : crumb.label}
                </Link>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
