import { HeartbeatRecord, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

/**
 * Interface for microservice health monitoring.
 *
 * Tracks the health, uptime, and session counts of the downstream
 * services (SMR, NLP, STT v2, Guardrail, Harness) via periodic health
 * checks and Redis-backed heartbeat storage.
 */
export interface IServiceHealthMonitoringService {
  /**
   * Get uptime data for all monitored services.
   */
  getUptime(): Promise<UptimeResponse>;

  /**
   * Get uptime data for a specific service.
   * @param serviceName - Display name of the service
   * @returns Service uptime data, or null if service not found
   */
  getServiceUptime(serviceName: string): Promise<ServiceUptime | null>;

  /**
   * Get heartbeat history for a specific service.
   * @param serviceName - Display name of the service
   * @returns Array of heartbeat records (newest first)
   */
  getHeartbeatHistory(serviceName: string): Promise<HeartbeatRecord[]>;

  /**
   * Get active session counts for all services.
   */
  getSessionCounts(): Promise<SessionsResponse>;
}

export const IServiceHealthMonitoringService = Symbol('IServiceHealthMonitoringService');
