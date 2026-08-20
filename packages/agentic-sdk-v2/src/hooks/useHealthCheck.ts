/**
 * @arcaai/vox - useHealthCheck Hook
 *
 * Aggregated health check across API gateway and downstream services.
 *
 * Makes 3 calls in parallel:
 *   1. GET /health           – API gateway detailed health
 *   2. GET /health/live      – API gateway liveness
 *   3. GET /admin/health/services – Consolidated downstream service health
 *
 * The /admin/health/services response is flattened so each downstream service
 * (text, nlp, stt, guardrail, harness) appears as a top-level entry in the
 * services map alongside 'api' and 'apiLive'.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useAgenticStore } from '../store';
import { HEALTH_ENDPOINTS, SERVICE_HEALTH_ENDPOINTS } from '../core/constants';
import { withRetry } from '../utils/errorUtils';
import type { HealthStatus, ServiceHealthStatus } from '../types/health';

export interface UseHealthCheckReturn {
  status: HealthStatus;
  services: Record<string, ServiceHealthStatus>;
  lastChecked: Date | null;
  isLoading: boolean;
  error: Error | null;
  check: () => Promise<void>;
  startPolling: (intervalMs?: number) => void;
  stopPolling: () => void;
}

interface ConsolidatedServicesResponse {
  status: string;
  timestamp: string;
  services: Record<string, ServiceHealthStatus>;
}

const GATEWAY_CHECKS = [
  { key: 'api', endpoint: HEALTH_ENDPOINTS.HEALTH },
  { key: 'apiLive', endpoint: HEALTH_ENDPOINTS.LIVE },
] as const;

function deriveStatus(gatewayResults: Record<string, ServiceHealthStatus | null>, servicesResult: ConsolidatedServicesResponse | null): HealthStatus {
  const gatewayEntries = Object.values(gatewayResults);
  const gatewayOk = gatewayEntries.filter((r) => r !== null).length;

  if (!servicesResult) {
    if (gatewayOk === gatewayEntries.length) return 'degraded';
    if (gatewayOk === 0) return 'unhealthy';
    return 'degraded';
  }

  const serviceStatuses = Object.values(servicesResult.services);
  const servicesDown = serviceStatuses.filter((s) => s.status === 'down').length;

  if (gatewayOk === gatewayEntries.length && servicesDown === 0) return 'healthy';
  if (gatewayOk === 0 && servicesDown === serviceStatuses.length) return 'unhealthy';
  return 'degraded';
}

export function useHealthCheck(): UseHealthCheckReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useHealthCheck'), [store.logger]);

  const [status, setStatus] = useState<HealthStatus>('idle');
  const [services, setServices] = useState<Record<string, ServiceHealthStatus>>({});
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async (): Promise<void> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    setStatus('checking');
    const timer = logger?.startOperation('check');
    try {
      const [gatewayResults, servicesResult] = await Promise.all([
        Promise.allSettled(
          GATEWAY_CHECKS.map(({ endpoint }) => withRetry(() => apiClient.get<ServiceHealthStatus>(endpoint), { maxRetries: 1, delayMs: 500 })),
        ),
        withRetry(() => apiClient.get<ConsolidatedServicesResponse>(SERVICE_HEALTH_ENDPOINTS.SERVICES), { maxRetries: 1, delayMs: 500 }).catch(
          () => null,
        ),
      ]);

      const serviceMap: Record<string, ServiceHealthStatus> = {};
      const resultMap: Record<string, ServiceHealthStatus | null> = {};

      GATEWAY_CHECKS.forEach(({ key }, i) => {
        const result = gatewayResults[i];
        if (result.status === 'fulfilled') {
          serviceMap[key] = result.value;
          resultMap[key] = result.value;
        } else {
          serviceMap[key] = { status: 'down' };
          resultMap[key] = null;
        }
      });

      if (servicesResult?.services) {
        for (const [key, svc] of Object.entries(servicesResult.services)) {
          serviceMap[key] = svc;
        }
      }

      setServices(serviceMap);
      setLastChecked(new Date());
      setStatus(deriveStatus(resultMap, servicesResult));
      timer?.end(true);
    } catch (err) {
      setError(err as Error);
      setStatus('unhealthy');
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (intervalMs = 30000) => {
      stopPolling();
      intervalRef.current = setInterval(() => {
        check().catch(() => {});
      }, intervalMs);
    },
    [check, stopPolling],
  );

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return useMemo(
    () => ({
      status,
      services,
      lastChecked,
      isLoading,
      error,
      check,
      startPolling,
      stopPolling,
    }),
    [status, services, lastChecked, isLoading, error, check, startPolling, stopPolling],
  );
}
