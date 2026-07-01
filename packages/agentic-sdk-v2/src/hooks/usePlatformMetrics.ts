/**
 * @arcaai/vox — usePlatformMetrics Hook (TASK-386 #16).
 *
 * Reads the three super-admin platform runtime tiles:
 *   - E1 `/admin/platform/metrics`     → requests/min, error rate, P95, sockets,
 *                                         per-service/-model, request-volume series.
 *   - E2 `/admin/platform/sockets`     → live open-socket count (multi-instance).
 *   - E3 `/admin/platform/consumption` → transcription minutes, summaries-24h,
 *                                         storage used/quota, consultations.
 *
 * Each backend read is Redis-cached (~12s) and graceful: Prometheus-derived
 * fields fall back to 0/[]/null when Prometheus is down, so a partial outage
 * still renders the dashboard. `refresh()` fetches all three with
 * `Promise.allSettled`, so one failing tile never blanks the others.
 */

import { useCallback, useMemo, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { PLATFORM_METRICS_ENDPOINTS } from '../core/constants';
import type { ConsumptionRollup, OpenSockets, PlatformMetrics } from '../types/platform-metrics';

export interface UsePlatformMetricsReturn {
  metrics: PlatformMetrics | null;
  sockets: OpenSockets | null;
  consumption: ConsumptionRollup | null;
  isLoading: boolean;
  error: Error | null;
  /** Fetch all three tiles. `tenantId` scopes the consumption roll-up (omit = platform-wide). */
  refresh: (tenantId?: string | null) => Promise<void>;
  /** Fetch only the consumption roll-up (E3) — used by tenant-scoped dashboards. */
  refreshConsumption: (tenantId?: string | null) => Promise<ConsumptionRollup>;
}

export function usePlatformMetrics(): UsePlatformMetricsReturn {
  const { execute, isLoading, error } = useApiOperation('usePlatformMetrics');

  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null);
  const [sockets, setSockets] = useState<OpenSockets | null>(null);
  const [consumption, setConsumption] = useState<ConsumptionRollup | null>(null);

  const refresh = useCallback(
    async (tenantId?: string | null): Promise<void> => {
      await execute<void>('refresh', async (client) => {
        const [metricsRes, socketsRes, consumptionRes] = await Promise.allSettled([
          client.get<PlatformMetrics>(PLATFORM_METRICS_ENDPOINTS.METRICS),
          client.get<OpenSockets>(PLATFORM_METRICS_ENDPOINTS.SOCKETS),
          client.get<ConsumptionRollup>(PLATFORM_METRICS_ENDPOINTS.CONSUMPTION(tenantId ?? undefined)),
        ]);
        if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);
        if (socketsRes.status === 'fulfilled') setSockets(socketsRes.value);
        if (consumptionRes.status === 'fulfilled') setConsumption(consumptionRes.value);
      });
    },
    [execute],
  );

  const refreshConsumption = useCallback(
    (tenantId?: string | null): Promise<ConsumptionRollup> =>
      execute<ConsumptionRollup>('refreshConsumption', async (client) => {
        const result = await client.get<ConsumptionRollup>(PLATFORM_METRICS_ENDPOINTS.CONSUMPTION(tenantId ?? undefined));
        setConsumption(result);
        return result;
      }),
    [execute],
  );

  return useMemo(
    () => ({ metrics, sockets, consumption, isLoading, error, refresh, refreshConsumption }),
    [metrics, sockets, consumption, isLoading, error, refresh, refreshConsumption],
  );
}
