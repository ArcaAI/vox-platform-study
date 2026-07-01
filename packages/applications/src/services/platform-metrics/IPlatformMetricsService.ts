import { PlatformMetricsResponse, OpenSocketsResponse, ConsumptionRollupResponse } from './dto';

/**
 * TASK-386 — platform runtime metrics read service (E1/E2/E3).
 *
 * All methods are READ-ONLY and emit NO audit/SysEvent (decision #8). Responses
 * are Redis-cached with a short TTL (~10-15s) since the FE polls ~15s.
 */
export abstract class IPlatformMetricsService {
  /** E1 — platform runtime metrics (super-admin). */
  abstract getPlatformMetrics(): Promise<PlatformMetricsResponse>;
  /** E2 — open-sockets tile (super-admin). */
  abstract getOpenSockets(): Promise<OpenSocketsResponse>;
  /**
   * E3 — consumption / usage roll-up. `tenantId = null` → platform-wide
   * (super-admin); a non-null id scopes the aggregates to that tenant.
   */
  abstract getConsumptionRollup(tenantId: string | null): Promise<ConsumptionRollupResponse>;
}

export const IPlatformMetricsServiceToken = Symbol('IPlatformMetricsService');
