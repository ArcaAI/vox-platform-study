/** Python service key accepted by health/monitoring routes. */
export type MonitoredService = 'smr' | 'nlp' | 'stt' | 'tts' | 'guardrail' | 'harness';

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

/** GET /health/services — per-service liveness probe fan-out. */
export interface HealthServices {
    status: string;
    timestamp: string;
    services: Record<string, ServiceProbe>;
}

export interface ServiceProbe {
    status: string;
    service: string;
    uptime_seconds?: number;
    duration_ms?: number;
    error?: string;
}

export interface HeartbeatRecord {
    timestamp: string;
    status: 'up' | 'down';
    responseTime: number;
}

export interface ServiceUptime {
    status: ServiceStatus;
    uptime: number;
    responseTime: number;
    lastCheck: string;
    heartbeats: HeartbeatRecord[];
}

/** GET /monitoring/uptime. */
export interface UptimeOverview {
    services: Record<string, ServiceUptime>;
    refreshedAt: string;
}

/** GET /monitoring/sessions. */
export interface SessionsOverview {
    services: Record<MonitoredService, { active: number }>;
    totalUsers: number;
    refreshedAt: string;
}

/** GET /admin/queues/health/redis. */
export interface RedisHealthInfo {
    status: 'healthy' | 'degraded' | 'unhealthy';
    latencyMs: number;
    connectedClients: number;
    usedMemory: string;
    uptime: number;
    version: string;
    queuesRegistered: number;
}
