'use client';

import { IconBuilding } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';

/**
 * Tier 30–49 scope gate (frame 09 NoTenant template, generalized from the
 * tenant-storage screen): an elevated session without a working tenant would
 * fire queries that can only 400 ("Tenant ID is required"), so the screen
 * body must not mount until the scope is known. Tenant admins are always
 * tenant-pinned and pass straight through; /consultations does NOT use this
 * gate (frame 40's documented exception renders a cross-tenant aggregate).
 */
export function WorkingTenantGate({
  title,
  meta,
  description,
  children,
}: {
  /** Screen h1, repeated here so the gate/loading states keep the heading. */
  title: ReactNode;
  /** Muted meta line under the h1 (endpoint hints), shown with the gate. */
  meta?: ReactNode;
  /** Gate copy; defaults to the generic tier 30–49 wording. */
  description?: ReactNode;
  children: ReactNode;
}) {
  const session = useSession();

  if (!session.data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title} meta={<Skeleton className="h-4 w-40" />} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Key off the EFFECTIVE identity, not the operator's:
  // while impersonating, isElevated/workingTenantId stay the operator's
  // (always elevated, often no working tenant picked), which fired this
  // gate even though the impersonated target is tenant-bound.
  if (session.data.effectiveIsElevated && !session.data.effectiveTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title} meta={meta} />
        <EmptyState
          icon={IconBuilding}
          title="Select a working tenant"
          description={description ?? 'This screen is tenant-scoped. Pick a working tenant from the switcher in the top bar to load its data.'}
        />
      </div>
    );
  }

  return children;
}
