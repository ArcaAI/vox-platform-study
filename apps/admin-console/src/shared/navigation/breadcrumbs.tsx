'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@arcaai/ui/components/shadcn/breadcrumb';
import { useBreadcrumbStore } from '@/shared/navigation/breadcrumb-store';
import { matchNavEntry, NAV_SECTIONS } from '@/shared/navigation/nav-config';

/**
 * Topbar breadcrumb (frame 07): tier section label / screen label
 * [/ resolved detail name]. Detail names come from the breadcrumb store.
 */
export function Breadcrumbs() {
  const pathname = usePathname();
  const trailing = useBreadcrumbStore((state) => state.trailing);
  const entry = matchNavEntry(pathname);
  if (!entry) return null;

  const section = NAV_SECTIONS.find((candidate) => candidate.tier === entry.tier);
  const isDetail = pathname !== entry.route;
  const detailLabel = trailing ?? pathname.slice(entry.route.length + 1).split('/')[0];

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {section ? (
          <>
            <BreadcrumbItem className="max-sm:hidden">{section.label}</BreadcrumbItem>
            <BreadcrumbSeparator className="max-sm:hidden" />
          </>
        ) : null}
        <BreadcrumbItem>
          {isDetail ? (
            <BreadcrumbLink asChild>
              <Link href={entry.route}>{entry.label}</Link>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{entry.label}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {isDetail ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-56 truncate">{detailLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
