'use client';

import { useState } from 'react';
import { IconBuilding } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import type { ResolvedProviderScope } from './use-provider-scope';

/**
 * WHAT THE TENANT TIER COSTS YOU, SAID ON THE SCREEN (TASK-983 R3, OD-1).
 *
 * The owner reported being unable to change the platform Sarvam key once a
 * tenant admin had configured one for their tenant. The API sequence works —
 * W0 drove it end to end (tenant `PUT ?tenantId=<tenant>` → 200, then super
 * admin `PUT ?tenantId=<SYSTEM>` → 200 with `keyVersion` bumped, even with a
 * working tenant still set on the request). The block was here: to configure a
 * tenant you select it in the switcher, and NOTHING ever clears it again, so
 * every later visit to this screen is the tenant tier. The scope badge said so
 * and was read as decoration.
 *
 * So this states the CONSEQUENCE rather than the state — "platform defaults are
 * edited with no working tenant" — and carries the control that gets you there,
 * on the screen where the question is asked. It is not a second tenancy
 * control: it can only CLEAR, exactly as the shell's own banner does, and
 * selecting a tenant remains the switcher's job alone (R-12 — the tier toggle
 * this screen used to have is not coming back).
 *
 * A tenant-bound admin falls through to the passive shell banner: it has no
 * other tier to reach, and an instruction it cannot follow is worse than none.
 */
export function ProviderScopeNotice({ scope }: { scope: ResolvedProviderScope }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  if (!scope.elevated) return <TenantScopeBanner />;

  async function clearWorkingTenant() {
    setPending(true);
    try {
      // The shell switcher's own route. Scope changed: server components
      // re-read the session and every query refetches against the new tier.
      await fetch('/api/auth/working-tenant', { method: 'DELETE' });
      await queryClient.invalidateQueries();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div role="status" className="bg-warning/10 text-foreground flex flex-wrap items-center gap-2 px-4 py-1.5 text-sm">
      <IconBuilding aria-hidden className="text-warning size-4 shrink-0" />
      <span className="min-w-0">
        Acting on <span className="font-medium">«{scope.label}»</span> — you are editing this tenant&apos;s own provider connections. Platform defaults
        are edited with no working tenant.
      </span>
      <Button variant="outline" size="sm" className="ml-auto shrink-0" disabled={pending} onClick={() => void clearWorkingTenant()}>
        Clear the working tenant
      </Button>
    </div>
  );
}
