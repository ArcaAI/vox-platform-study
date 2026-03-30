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
 * Response for sessions endpoint
 */
export interface SessionsResponse {
  services: {
    tts: ServiceSessionCount;
    smr: ServiceSessionCount;
  };
  totalUsers: number;
  refreshedAt: string;
}
