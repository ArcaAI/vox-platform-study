/**
 * @arcaai/vox - useDnaDashboard Hook (TASK-328 A5)
 *
 * DNA aggregate dashboard for the admin DNA page. Reads
 * `GET /admin/dna-writing-styles/dashboard` which the server gates with
 * `@Authorize(['manage', 'DnaWritingStyleReport'])`, so a plain DOCTOR is
 * denied (403) — surfaced here as a clean `AgenticError('FORBIDDEN')`.
 *
 * Tenant scoping is enforced server-side: a global admin
 * (SUPER_ADMIN/GLOBAL_ADMIN) may pass `tenantId` to scope the aggregate (or
 * omit it for an all-tenants roll-up); a tenant admin is pinned to their CLS
 * tenant and any supplied `tenantId` is ignored.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { DNA_STYLE_ENDPOINTS } from '../core/constants';
import type { DnaDashboard } from '../types';

export interface UseDnaDashboardReturn {
  dashboard: DnaDashboard | null;
  isLoading: boolean;
  error: Error | null;
  /**
   * Fetch the aggregate dashboard. `tenantId` is honoured only for global
   * admins (ignored server-side for tenant admins).
   */
  fetchDashboard: (tenantId?: string) => Promise<DnaDashboard>;
}

export function useDnaDashboard(): UseDnaDashboardReturn {
  const { execute, isLoading, error } = useApiOperation('useDnaDashboard');

  const [dashboard, setDashboard] = useState<DnaDashboard | null>(null);

  const fetchDashboard = useCallback(
    (tenantId?: string): Promise<DnaDashboard> =>
      execute<DnaDashboard>('fetchDashboard', async (client) => {
        const data = await client.get<DnaDashboard>(DNA_STYLE_ENDPOINTS.ADMIN_DASHBOARD(tenantId));
        setDashboard(data);
        return data;
      }),
    [execute],
  );

  return { dashboard, isLoading, error, fetchDashboard };
}
