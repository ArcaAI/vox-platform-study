/**
 * @arcaai/vox - Health Check Types (TASK-032 WS-A)
 *
 * Types for the HOPE standardized health contract.
 *
 * All services use three status values: "healthy", "degraded", "unhealthy".
 * Detailed health responses include service name, version, uptime, and
 * per-component checks with duration_ms.
 */

export type HealthStatus = 'idle' | 'checking' | 'healthy' | 'degraded' | 'unhealthy';

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentCheck {
  status: ComponentStatus;
  duration_ms: number;
  message?: string;
}

export interface ServiceHealthStatus {
  status: string;
  service?: string;
  version?: string;
  uptime_seconds?: number;
  duration_ms?: number;
  timestamp?: string;
  error?: string;
  checks?: Record<string, ComponentCheck>;
  [key: string]: unknown;
}
