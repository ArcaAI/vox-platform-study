'use client';

import { useQuery } from '@tanstack/react-query';
import { getConsumption, getOpenSockets, getPlatformMetrics } from './client';
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
