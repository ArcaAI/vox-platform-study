/**
 * Service health status enum
 */
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * Single heartbeat record
 */
export interface HeartbeatRecord {
  timestamp: string;
  status: 'up' | 'down';
  responseTime: number;
}

/**
 * Service uptime information
 */
export interface ServiceUptime {
  status: ServiceStatus;
  uptime: number;
  responseTime: number;
  lastCheck: string;
  heartbeats: HeartbeatRecord[];
}

/**
 * Response for uptime endpoint
 */
export interface UptimeResponse {
  services: Record<string, ServiceUptime>;
  refreshedAt: string;
}

/**
 * Service session counts
 */
export interface ServiceSessionCount {
  active: number;
}

/**
 * Response for sessions endpoint.
 *
 * Covers the real downstream services (smr, stt, tts, nlp, guardrail, harness) so
 * the sessions surface stays aligned with uptime/health. Counts are static
 * placeholders; see ServiceHealthMonitoringService.getSessionCounts (no
 * per-service polling).
 */
export interface SessionsResponse {
  services: {
    smr: ServiceSessionCount;
    stt: ServiceSessionCount;
    tts: ServiceSessionCount;
    nlp: ServiceSessionCount;
    guardrail: ServiceSessionCount;
    harness: ServiceSessionCount;
  };
  totalUsers: number;
  refreshedAt: string;
}
