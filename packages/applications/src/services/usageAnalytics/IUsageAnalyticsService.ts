import { AiCapability } from '@arcaai/domains';

import { BudgetBurndownResponse, CostPerEncounterResponse, TopTenantsResponse, UsageSummaryResponse, UsageTimeseriesResponse } from './dto';
import { UsageTimeseriesGranularity } from './range-bounds';

export interface UsageTimeseriesQuery {
  capability: AiCapability;
  unit: string;
  granularity: UsageTimeseriesGranularity;
  from: Date;
  to: Date;
}

export interface TopTenantsQuery {
  limit: number;
  capability?: AiCapability;
}

/**
 * Read-only usage-analytics queries over the TASK-615 ledger rollups
 * (WS-J). Complements — does not duplicate — the WS-I billing read models
 * (`IBillingService`): this surface answers "what happened and how much did
 * it cost", billing answers "what does the tenant owe".
 *
 * `tenantId` on every per-tenant method is the CALLER-SCOPED tenant, resolved
 * by the controller (`resolveScopedTenantId`); `getTopTenants` is the one
 * deliberately cross-tenant exception (GLOBAL_ADMIN only).
 */
export interface IUsageAnalyticsService {
  /** Units + rated cost per capability × provider × model for a billing period. BYOK notional split out. */
  getUsageSummary(tenantId: string, period: string): Promise<UsageSummaryResponse>;

  /** Bounded-range rollup timeseries for one capability × unit. Throws `ArgumentInvalidException` beyond the range cap. */
  getUsageTimeseries(tenantId: string, query: UsageTimeseriesQuery): Promise<UsageTimeseriesResponse>;

  /** p50/p90/p99 + count of Σ cost per consultation over a billing period (INTERNAL basis). */
  getCostPerEncounter(tenantId: string, period: string): Promise<CostPerEncounterResponse>;

  /** GLOBAL-ADMIN-only cross-tenant top-N by rollup cost. */
  getTopTenants(period: string, query: TopTenantsQuery): Promise<TopTenantsResponse>;

  /** Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection. */
  getBudgetBurndown(tenantId: string, period: string): Promise<BudgetBurndownResponse>;
}

export const IUsageAnalyticsService = Symbol('IUsageAnalyticsService');
