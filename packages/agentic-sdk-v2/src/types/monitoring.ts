/**
 * @arcaai/vox - Monitoring Types (TASK-032 WS-A)
 *
 * Types for service monitoring and health tracking.
 * Matches MonitoringController responses.
 */

export interface ServiceUptime {
  service: string;
  status: string;
  uptimeSeconds: number;
  [key: string]: unknown;
}

export interface SessionCounts {
  active: number;
  total: number;
  activeSessions: number;
  processingJobs: number;
  [key: string]: unknown;
}

export interface HeartbeatRecord {
  timestamp: string;
  status: string;
  latencyMs?: number;
  [key: string]: unknown;
}
