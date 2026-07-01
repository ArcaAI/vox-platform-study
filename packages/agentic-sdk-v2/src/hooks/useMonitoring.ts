/**
 * @arcaai/vox - useMonitoring Hook (TASK-032 WS-A)
 *
 * Service monitoring hook with uptime, sessions, and heartbeat data.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { MONITORING_ENDPOINTS } from '../core/constants';
import type { ServiceSessionCount, ServiceUptime, SessionCounts, HeartbeatRecord } from '../types/monitoring';

const SESSION_SERVICE_KEYS = ['smr', 'stt', 'nlp', 'guardrail', 'harness'] as const;

/**
 * Normalize the backend `SessionsResponse`
 *   `{ services: { smr|stt|nlp|guardrail|harness: { active } }, totalUsers, refreshedAt }`
 * into `SessionCounts`, computing the DERIVED tile values (TASK-386):
 *   - `activeSessions` ≈ live consultations ≈ `services.stt.active` (the live STT stream).
 *   - `processingJobs` ≈ background inference ≈ SMR + NLP + guardrail + harness active.
 * Falls back to all-zero on a missing/malformed body so tiles render 0, never NaN.
 */
function normalizeSessionCounts(raw: Record<string, unknown> | null | undefined): SessionCounts {
  const rawServices = (raw && typeof raw === 'object' ? (raw as { services?: unknown }).services : null) ?? {};
  const readActive = (key: string): ServiceSessionCount => {
    const entry = (rawServices as Record<string, unknown>)[key];
    const active = entry && typeof entry === 'object' && typeof (entry as { active?: unknown }).active === 'number' ? (entry as { active: number }).active : 0;
    return { active };
  };

  const services = {
    smr: readActive('smr'),
    stt: readActive('stt'),
    nlp: readActive('nlp'),
    guardrail: readActive('guardrail'),
    harness: readActive('harness'),
  };

  const totalUsers = raw && typeof (raw as { totalUsers?: unknown }).totalUsers === 'number' ? (raw as { totalUsers: number }).totalUsers : 0;
  const refreshedAt = raw && typeof (raw as { refreshedAt?: unknown }).refreshedAt === 'string' ? (raw as { refreshedAt: string }).refreshedAt : undefined;

  const activeSessions = services.stt.active;
  const processingJobs = services.smr.active + services.nlp.active + services.guardrail.active + services.harness.active;
  const total = SESSION_SERVICE_KEYS.reduce((sum, key) => sum + services[key].active, 0);

  return { services, totalUsers, refreshedAt, activeSessions, processingJobs, active: activeSessions, total };
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
