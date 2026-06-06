import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — mirror the backend monitoring + health DTOs
// (apps/api/.../monitoring/dto/monitoring.dto.ts, .../health/health.controller.ts).
// OB-01: these read-only endpoints already exist server-side but had no console
// surface. This client only consumes them — no backend changes.
// ---------------------------------------------------------------------------

export type ServiceHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface HeartbeatRecord {
  timestamp: string;
  status: 'up' | 'down';
  responseTime: number;
}

export interface ServiceUptime {
  status: ServiceHealthStatus;
  uptime: number;
  responseTime: number;
  lastCheck: string;
  heartbeats: HeartbeatRecord[];
}

/** `GET /monitoring/uptime` */
export interface UptimeResponse {
  services: Record<string, ServiceUptime>;
  refreshedAt: string;
}

export interface ServiceSessionCount {
  active: number;
}

/** `GET /monitoring/sessions` (the backend reports tts + smr today; OB-13). */
export interface SessionsResponse {
  services: Record<string, ServiceSessionCount>;
  totalUsers: number;
  refreshedAt: string;
}

/** A single downstream probe inside `GET /health/services`. */
export interface DownstreamServiceProbe {
  status: string;
  service: string;
  uptime_seconds?: number;
  duration_ms?: number;
  error?: string;
}

/** `GET /health/services` */
export interface ServicesHealthResponse {
  status: string;
  timestamp: string;
  services: Record<string, DownstreamServiceProbe>;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const monitoringKeys = {
  all: ['admin', 'monitoring'] as const,
  uptime: () => [...monitoringKeys.all, 'uptime'] as const,
  sessions: () => [...monitoringKeys.all, 'sessions'] as const,
  services: () => [...monitoringKeys.all, 'services'] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useServiceUptime(options?: Omit<UseQueryOptions<UptimeResponse>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: monitoringKeys.uptime(),
    queryFn: () => adminClient.get<UptimeResponse>('/monitoring/uptime'),
    ...options,
  });
}

export function useServiceSessions(options?: Omit<UseQueryOptions<SessionsResponse>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: monitoringKeys.sessions(),
    queryFn: () => adminClient.get<SessionsResponse>('/monitoring/sessions'),
    ...options,
  });
}

export function useServicesHealth(options?: Omit<UseQueryOptions<ServicesHealthResponse>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: monitoringKeys.services(),
    queryFn: () => adminClient.get<ServicesHealthResponse>('/health/services'),
    ...options,
  });
}
