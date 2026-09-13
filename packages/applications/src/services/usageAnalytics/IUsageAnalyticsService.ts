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
 * Read-only usage-analytics queries over the ledger rollups
 * . Complements — does not duplicate — the billing read models
 * (`IBillingService`): this surface answers "what happened and how much did
 * it cost", billing answers "what does the tenant owe".
 *
 * `tenantId` on every per-tenant method is the CALLER-SCOPED tenant, resolved
 * by the controller (`resolveScopedTenantId`); `getTopTenants` is the one
 * deliberately cross-tenant exception (SUPER_ADMIN only).
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

  /**
   * TASK-959 §3.4 — Σ `CPU_SECOND` under capability `WORKFLOW` for ONE workflow
   * run, tenant-scoped. `null` when the run has no worker-CPU rows at all.
   *
   * Takes the run's **`sessionId`**, not its run id (corrected under TASK-957):
   * the ledger's `requestId` on a WORKFLOW row is Temporal's execution-attempt
   * id, and `sessionId` is the key `WorkflowRun` already joins its own steps by.
   * See the implementation for the full reasoning.
   *
   * On this interface rather than the workflow-run service because it is a
   * LEDGER question, not a run question: the workflow-run read plane has no
   * business learning the metering schema to answer it.
   */
  getWorkflowRunCpuSeconds(tenantId: string, sessionId: string): Promise<number | null>;
}

export const IUsageAnalyticsService = Symbol('IUsageAnalyticsService');
