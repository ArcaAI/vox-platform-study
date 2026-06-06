import { ApiProperty } from '@nestjs/swagger';

/**
 * Service health status enum
 */
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * Single heartbeat record
 */
export class HeartbeatRecord {
  @ApiProperty({ description: 'Timestamp of heartbeat check' })
  timestamp: string;

  @ApiProperty({ enum: ['up', 'down'], description: 'Service status at check time' })
  status: 'up' | 'down';

  @ApiProperty({ description: 'Response time in milliseconds' })
  responseTime: number;
}

/**
 * Service uptime information
 */
export class ServiceUptime {
  @ApiProperty({ enum: ['healthy', 'degraded', 'down', 'unknown'], description: 'Current service status' })
  status: ServiceStatus;

  @ApiProperty({ description: 'Uptime percentage (0-100)' })
  uptime: number;

  @ApiProperty({ description: 'Latest response time in milliseconds' })
  responseTime: number;

  @ApiProperty({ description: 'Last health check timestamp (ISO)' })
  lastCheck: string;

  @ApiProperty({ type: [HeartbeatRecord], description: 'Recent heartbeat history' })
  heartbeats: HeartbeatRecord[];
}

/**
 * Response for GET /monitoring/uptime
 */
export class UptimeResponse {
  @ApiProperty({ description: 'Service uptime data by service name' })
  services: Record<string, ServiceUptime>;

  @ApiProperty({ description: 'Response timestamp (ISO)' })
  refreshedAt: string;
}

/**
 * Service session counts
 */
export class ServiceSessionCount {
  @ApiProperty({ description: 'Active session count' })
  active: number;
}

/**
 * Response for GET /monitoring/sessions
 */
export class SessionsResponse {
  @ApiProperty({ description: 'Session counts per service (tts, smr, stt, nlp)' })
  services: {
    tts: ServiceSessionCount;
    smr: ServiceSessionCount;
    stt: ServiceSessionCount;
    nlp: ServiceSessionCount;
  };

  @ApiProperty({ description: 'Total unique users with sessions' })
  totalUsers: number;

  @ApiProperty({ description: 'Response timestamp (ISO)' })
  refreshedAt: string;
}
