'use client';

import { IconBuilding } from '@tabler/icons-react';
import { useSession } from '@/shared/auth';

/**
 * Per-page tenant-scope banner (redesign build spec, region 1). Info-tinted
 * strip for the `ScreenTemplate` `statusBanner` slot on tenant-scoped (tier
 * 30–49) pages, naming the working tenant every mutation runs against. Unlike the
 * global `WorkingTenantBanner` (frame 07, warning-tinted, with the clear-tenant
 * control), this is a passive in-page reminder with no action — the switcher owns
 * the control. Renders nothing until a working tenant is selected.
 */
export function TenantScopeBanner() {
  const session = useSession();
  const workingTenantId = session.data?.workingTenantId;
  if (!workingTenantId) return null;
  const name = session.data?.workingTenantName ?? workingTenantId;

  return (
    <div role="status" className="bg-info/10 text-foreground flex items-center gap-2 px-4 py-1.5 text-sm">
      <IconBuilding aria-hidden className="text-info size-4 shrink-0" />
      <span className="min-w-0 truncate">
        Acting on <span className="font-medium">«{name}»</span> — tenant-scoped actions run against this tenant&apos;s data.
      </span>
    </div>
  );
}
