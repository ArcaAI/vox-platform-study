import { PlatformMetricsResponse, OpenSocketsResponse, ConsumptionRollupResponse } from './dto';

/**
 * Platform runtime metrics read service.
 *
 * All methods are READ-ONLY and emit NO audit/SysEvent. Responses
 * are Redis-cached with a short TTL (~10-15s) since the FE polls ~15s.
 */
export abstract class IPlatformMetricsService {
  /** Platform runtime metrics (super-admin). */
  abstract getPlatformMetrics(): Promise<PlatformMetricsResponse>;
  /** Open-sockets tile (super-admin). */
  abstract getOpenSockets(): Promise<OpenSocketsResponse>;
  /**
   * Consumption / usage roll-up. `tenantId = null` → platform-wide
   * (super-admin); a non-null id scopes the aggregates to that tenant.
   */
  abstract getConsumptionRollup(tenantId: string | null): Promise<ConsumptionRollupResponse>;
}

export const IPlatformMetricsServiceToken = Symbol('IPlatformMetricsService');
