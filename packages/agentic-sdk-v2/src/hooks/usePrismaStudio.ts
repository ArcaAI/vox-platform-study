/**
 * @arcaai/vox - usePrismaStudio Hook
 *
 * Availability probe for the dev-only Prisma Studio shell. The Studio module
 * itself is conditionally registered (NODE_ENV=development +
 * ENABLE_PRISMA_STUDIO=true); this hook reads the always-on
 * `GET /admin/pstudio/status` endpoint so the admin console can render a
 * truthful enabled/disabled card. Global-admin only (`manage all`).
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { PSTUDIO_ENDPOINTS } from '../core/constants';
import type { PrismaStudioStatus } from '../types/ops-admin';

export interface UsePrismaStudioReturn {
  /** Studio availability in this environment. Null until first refresh. */
  status: PrismaStudioStatus | null;
  isLoading: boolean;
  error: Error | null;
  refreshStatus: () => Promise<PrismaStudioStatus>;
}

export function usePrismaStudio(): UsePrismaStudioReturn {
  const { execute, isLoading, error } = useApiOperation('usePrismaStudio');
  const [status, setStatus] = useState<PrismaStudioStatus | null>(null);

  const refreshStatus = useCallback(
    () =>
      execute<PrismaStudioStatus>('refreshStatus', async (client) => {
        const data = await client.get<PrismaStudioStatus>(PSTUDIO_ENDPOINTS.STATUS);
        setStatus(data);
        return data;
      }),
    [execute],
  );

  return { status, isLoading, error, refreshStatus };
}
