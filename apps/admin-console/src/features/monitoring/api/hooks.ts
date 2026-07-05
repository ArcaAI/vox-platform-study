'use client';

import { useQuery } from '@tanstack/react-query';
import { getRedisHealth, getServiceHealth, getServiceUptime, getServicesHealth, getSessions, getUptime, listHeartbeats } from './client';
import { monitoringKeys } from './keys';
import type { MonitoredService } from './types';

/** Health boards poll — /health/services is gateway-throttled at 30/min. */
const REFRESH_MS = 30_000;

export function useServicesHealth() {
    return useQuery({ queryKey: monitoringKeys.servicesHealth(), queryFn: getServicesHealth, refetchInterval: REFRESH_MS });
}

export function useServiceHealth(service: MonitoredService) {
    return useQuery({ queryKey: monitoringKeys.serviceHealth(service), queryFn: () => getServiceHealth(service), refetchInterval: REFRESH_MS });
}

export function useUptime() {
    return useQuery({ queryKey: monitoringKeys.uptime(), queryFn: getUptime, refetchInterval: REFRESH_MS });
}

export function useServiceUptime(service: MonitoredService) {
    return useQuery({ queryKey: monitoringKeys.serviceUptime(service), queryFn: () => getServiceUptime(service), refetchInterval: REFRESH_MS });
}

export function useHeartbeats(service: MonitoredService) {
    return useQuery({ queryKey: monitoringKeys.heartbeats(service), queryFn: () => listHeartbeats(service), refetchInterval: REFRESH_MS });
}

export function useSessions() {
    return useQuery({ queryKey: monitoringKeys.sessions(), queryFn: getSessions, refetchInterval: REFRESH_MS });
}

export function useRedisHealth() {
    return useQuery({ queryKey: monitoringKeys.redis(), queryFn: getRedisHealth, refetchInterval: REFRESH_MS });
}
