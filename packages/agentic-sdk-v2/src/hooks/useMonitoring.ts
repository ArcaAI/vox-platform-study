/**
 * @arcaai/vox - useMonitoring Hook (TASK-032 WS-A)
 *
 * Service monitoring hook with uptime, sessions, and heartbeat data.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { MONITORING_ENDPOINTS } from '../core/constants';
import type { ServiceUptime, SessionCounts, HeartbeatRecord } from '../types/monitoring';

function normalizeSessionCounts(raw: Record<string, unknown> | null | undefined): SessionCounts {
  if (!raw || typeof raw !== 'object') {
    return { active: 0, total: 0, activeSessions: 0, processingJobs: 0 };
  }
  const activeSessions = typeof raw.activeSessions === 'number' ? raw.activeSessions : typeof raw.active === 'number' ? raw.active : 0;
  const processingJobs = typeof raw.processingJobs === 'number' ? raw.processingJobs : 0;
  return { ...raw, active: activeSessions, total: typeof raw.total === 'number' ? raw.total : 0, activeSessions, processingJobs };
}

export interface UseMonitoringReturn {
  uptime: ServiceUptime[] | null;
  sessions: SessionCounts | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  getServiceUptime: (service: string) => Promise<ServiceUptime>;
  getHeartbeats: (service: string) => Promise<HeartbeatRecord[]>;
}

export function useMonitoring(): UseMonitoringReturn {
  const { execute, isLoading, error } = useApiOperation('useMonitoring');

  const [uptime, setUptime] = useState<ServiceUptime[] | null>(null);
  const [sessions, setSessions] = useState<SessionCounts | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    await execute<void>('refresh', async (client) => {
      const [uptimeRaw, sessionsRaw] = await Promise.all([
        client.get(MONITORING_ENDPOINTS.UPTIME),
        client.get<Record<string, unknown>>(MONITORING_ENDPOINTS.SESSIONS),
      ]);
      setUptime(extractArray<ServiceUptime>(uptimeRaw));
      setSessions(normalizeSessionCounts(sessionsRaw));
    });
  }, [execute]);

  const getServiceUptime = useCallback(
    (service: string): Promise<ServiceUptime> =>
      execute<ServiceUptime>('getServiceUptime', (client) => client.get<ServiceUptime>(MONITORING_ENDPOINTS.SERVICE_UPTIME(service))),
    [execute],
  );

  const getHeartbeats = useCallback(
    (service: string): Promise<HeartbeatRecord[]> =>
      execute<HeartbeatRecord[]>('getHeartbeats', async (client) => {
        const raw = await client.get(MONITORING_ENDPOINTS.HEARTBEATS(service));
        return extractArray<HeartbeatRecord>(raw);
      }),
    [execute],
  );

  return {
    uptime,
    sessions,
    isLoading,
    error,
    refresh,
    getServiceUptime,
    getHeartbeats,
  };
}
