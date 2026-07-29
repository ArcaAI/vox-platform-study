'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconSpy } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@arcaai/ui/components/shadcn/button';
import type { SafeSession } from '@/shared/auth/hooks';
import { invalidateGridLayoutCache } from '@/shared/data/grid-persistence';

function useSessionAction(url: string, method: 'POST' | 'DELETE') {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      await fetch(url, { method });
      invalidateGridLayoutCache();
      await queryClient.invalidateQueries();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return { run, pending };
}

/**
 * "Acting on" banner (frame 07): full-width warning strip shown while an
 * elevated admin has a working tenant selected — every tier 30–49 action and
 * tenant-scoped shared screen runs against that tenant's data.
 */
export function WorkingTenantBanner({ session }: { session: SafeSession }) {
  const { run, pending } = useSessionAction('/api/auth/working-tenant', 'DELETE');
  if (!session.workingTenantId) return null;
  const name = session.workingTenantName ?? session.workingTenantId;

  return (
    <div role="status" className="bg-warning/10 text-foreground flex items-center gap-2 border-b px-4 py-1.5 text-sm">
      <IconAlertTriangle aria-hidden className="text-warning size-4 shrink-0" />
      <span className="min-w-0 truncate">
        Acting on: <span className="font-medium">«{name}»</span> — tenant-scoped actions run against this tenant&apos;s data.
      </span>
      <Button variant="ghost" size="sm" className="ml-auto shrink-0" disabled={pending} onClick={() => void run()}>
        Clear working tenant
      </Button>
    </div>
  );
}

/**
 * Global impersonation banner (matrix row 16): persistent, destructive-tinted,
 * with the revoke action. All impersonated writes are audit-flagged.
 */
export function ImpersonationBanner({ session }: { session: SafeSession }) {
  const { run, pending } = useSessionAction('/api/auth/revoke-impersonation', 'POST');
  if (!session.impersonatingUserId) return null;
  const name = session.impersonatingUsername ?? session.impersonatingUserId;

  return (
    <div role="status" className="bg-destructive/10 text-foreground flex items-center gap-2 border-b px-4 py-1.5 text-sm">
      <IconSpy aria-hidden className="text-destructive size-4 shrink-0" />
      <span className="min-w-0 truncate">
        Impersonating <span className="font-medium">«{name}»</span> — every action is audit-flagged.
      </span>
      <Button variant="destructive" size="sm" className="ml-auto shrink-0" disabled={pending} onClick={() => void run()}>
        Revoke impersonation
      </Button>
    </div>
  );
}
