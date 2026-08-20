import { HeartbeatRecord, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

/**
 * Interface for microservice health monitoring.
 *
 * Tracks the health, uptime, and session counts of the downstream
 * services (TEXT, NLP, STT v2, Guardrail, Harness) via periodic health
 * checks and Redis-backed heartbeat storage.
 */
export interface IServiceHealthMonitoringService {
  /**
   * Get uptime data for all monitored services.
   */
  getUptime(): Promise<UptimeResponse>;

  /**
   * Get uptime data for a specific service.
   * @param serviceKey - Service key (text, nlp, stt, guardrail, harness)
   * @returns Service uptime data, or null if service not found
   */
  getServiceUptime(serviceKey: string): Promise<ServiceUptime | null>;

  /**
   * Get heartbeat history for a specific service.
   * @param serviceKey - Service key (text, nlp, stt, guardrail, harness)
   * @returns Array of heartbeat records (newest first)
   */
  getHeartbeatHistory(serviceKey: string): Promise<HeartbeatRecord[]>;

  /**
   * Get active session counts for all services.
   */
  getSessionCounts(): Promise<SessionsResponse>;
}

export const IServiceHealthMonitoringService = Symbol('IServiceHealthMonitoringService');
