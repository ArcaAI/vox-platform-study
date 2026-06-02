import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';

/**
 * ScopeSyncInit — TASK-327 T1 / D3.
 *
 * The active tenant (auth-store `tenantId`) is ALREADY wired into the SDK:
 * SDKProvider feeds it into `AgenticConfig.api.tenantId` and AgenticProvider
 * calls `client.updateTenantId(...)` on change. What is NOT handled is the
 * TanStack Query cache: admin server state (tenant configs, users,
 * dna-reports, …) is fetched with the `X-Tenant-Id` header but keyed without
 * the tenant id, so a tenant switch would otherwise serve another tenant's
 * stale rows.
 *
 * This effect-only component (mounted once INSIDE the QueryClientProvider)
 * invalidates the whole query cache whenever the selected tenant changes,
 * forcing every active query to refetch under the new tenant. The initial
 * mount is skipped so first paint / hydration does not trigger a needless
 * refetch storm.
 */
export function ScopeSyncInit() {
  const queryClient = useQueryClient();
  const tenantId = useAuthStore((s) => s.tenantId);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    void queryClient.invalidateQueries();
  }, [tenantId, queryClient]);

  return null;
}
