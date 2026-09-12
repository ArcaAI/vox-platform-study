'use client';

import { useQuery } from '@tanstack/react-query';
import { getConsumption, getOpenSockets, getPlatformMetrics, getTenantUsage } from './client';
import { platformKeys } from './keys';

/** Dashboard tiles poll at 30s — matches the gateway's snapshot cadence. */
const REFRESH_MS = 30_000;

export function usePlatformMetrics() {
  return useQuery({ queryKey: platformKeys.metrics(), queryFn: getPlatformMetrics, refetchInterval: REFRESH_MS });
}

export function useOpenSockets() {
  return useQuery({ queryKey: platformKeys.sockets(), queryFn: getOpenSockets, refetchInterval: REFRESH_MS });
}

export function useConsumption(tenantId?: string) {
  return useQuery({ queryKey: platformKeys.consumption(tenantId), queryFn: () => getConsumption(tenantId), refetchInterval: REFRESH_MS });
}

/** The tenant dashboard's usage tiles (TASK-954). Idle until the session has resolved a tenant. */
export function useTenantUsage(tenantId: string | null) {
  return useQuery({
    queryKey: platformKeys.tenantUsage(tenantId),
    queryFn: () => getTenantUsage(tenantId ?? ''),
    enabled: tenantId !== null,
    refetchInterval: REFRESH_MS,
  });
}
