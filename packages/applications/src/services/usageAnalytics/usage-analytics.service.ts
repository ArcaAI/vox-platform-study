import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import Decimal from 'decimal.js';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  AiCapability,
  AiUsageRollupDailyRepository,
  AiUsageRollupHourlyRepository,
  PlanEntitlementRepository,
  TenantEntitlementRepository,
  TenantRepository,
  UsageAnalyticsAggregateRepository,
} from '@arcaai/domains';

import { isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { resolveBillingAllowances } from '../billing/allowances';
import { parseBillingPeriod } from '../billing/billing-period';
import { CapabilityBurndownLine, TopTenantUsage, UsageSummaryLine, UsageSummaryResponse } from './dto';
import { BudgetBurndownResponse, CostPerEncounterResponse, TopTenantsResponse, UsageTimeseriesResponse } from './dto';
import { IUsageAnalyticsService, TopTenantsQuery, UsageTimeseriesQuery } from './IUsageAnalyticsService';
import { projectCapabilityBurndown } from './budget-burndown';
import { computeCostDistribution } from './percentile';
import { validateTimeseriesRange } from './range-bounds';

/**
 * Read-only usage-analytics surface over the TASK-615 ledger rollups (WS-J).
 *
 * DATA SOURCES — same posture as the WS-I invoice engine (D13): reads
 * ROLLUPS, never raw ledger events, for anything that scans a full period.
 * The two exceptions are bounded SQL AGGREGATES (`UsageAnalyticsAggregateRepository`,
 * same rationale as `BillingUsageAggregateRepository`) for the two shapes the
 * rollup dimension tuple cannot express: cost-per-CONSULTATION and
 * cross-TENANT top-N.
 *
 * G16 MIGRATION NOTE: `PlatformMetricsService.getConsumptionRollup` (the
 * ad-hoc `/admin/platform-metrics/consumption` view this module supersedes)
 * reads `AudioRecordingRepository`/`SummaryMetaRepository`/`MediaRepository`
 * directly — none of it is ledger-derived, so today's dashboard numbers do
 * not agree with `getUsageSummary`'s. This lane does NOT edit that module
 * (out of WS-J's boundary); the follow-up is to make `getConsumptionRollup`
 * delegate its `transcriptionMinutes`/`summaries24h` fields to
 * `getUsageSummary`/`getUsageTimeseries` once the platform-metrics owner
 * signs off on the response-shape change.
 */
@Injectable()
export class UsageAnalyticsService implements IUsageAnalyticsService {
  constructor(
    private readonly rollupDailyRepository: AiUsageRollupDailyRepository,
    private readonly rollupHourlyRepository: AiUsageRollupHourlyRepository,
    private readonly aggregateRepository: UsageAnalyticsAggregateRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly planEntitlementRepository: PlanEntitlementRepository,
    private readonly tenantEntitlementRepository: TenantEntitlementRepository,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  // ═════════════════════════════════════════════════════════════════════════
  // getUsageSummary
  // ═════════════════════════════════════════════════════════════════════════

  async getUsageSummary(tenantId: string, period: string): Promise<UsageSummaryResponse> {
    const billingPeriod = parseBillingPeriod(period);
    const rollups = await this.rollupDailyRepository.findByPeriod(tenantId, billingPeriod.start, billingPeriod.end);

    const byKey = new Map<string, UsageSummaryLine>();
    for (const rollup of rollups) {
      const key = `${rollup.capability}::${rollup.provider}::${rollup.model}::${rollup.unit}`;
      const existing = byKey.get(key);
      const quantity = new Decimal(existing?.quantity ?? '0').plus(new Decimal(String(rollup.quantitySum)));
      const cost = (existing ? BigInt(existing.costMicros) : 0n) + rollup.costMicrosSum;
      byKey.set(key, {
        capability: rollup.capability,
        provider: rollup.provider,
        model: rollup.model,
        unit: rollup.unit,
        quantity: quantity.toFixed(6),
        costMicros: cost.toString(),
      });
    }

    const lines = [...byKey.values()].sort(
      (a, b) =>
        a.capability.localeCompare(b.capability) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        a.unit.localeCompare(b.unit),
    );
    const totalCostMicros = lines.reduce((sum, line) => sum + BigInt(line.costMicros), 0n);

    const byokRows = await this.aggregateRepository.sumByokNotionalByCapability(tenantId, billingPeriod.start, billingPeriod.end);
    const byokNotionalCostMicrosByCapability = Object.fromEntries(byokRows.map((row) => [row.capability, row.costMicros.toString()]));

    const response = new UsageSummaryResponse();
    response.period = period;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.lines = lines;
    response.totalCostMicros = totalCostMicros.toString();
    response.byokNotionalCostMicrosByCapability = byokNotionalCostMicrosByCapability;
    return response;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // getUsageTimeseries
  // ═════════════════════════════════════════════════════════════════════════

  async getUsageTimeseries(tenantId: string, query: UsageTimeseriesQuery): Promise<UsageTimeseriesResponse> {
    validateTimeseriesRange(query.granularity, query.from, query.to);

    const buckets =
      query.granularity === 'day'
        ? await this.rollupDailyRepository.findByPeriod(tenantId, query.from, query.to)
        : await this.rollupHourlyRepository.findByPeriod(tenantId, query.from, query.to);

    const filtered = buckets.filter((bucket) => bucket.capability === query.capability && bucket.unit === query.unit);

    const byBucket = new Map<number, { quantity: Decimal; costMicros: bigint }>();
    for (const bucket of filtered) {
      const key = bucket.bucketStart.getTime();
      const existing = byBucket.get(key);
      byBucket.set(key, {
        quantity: (existing?.quantity ?? new Decimal(0)).plus(new Decimal(String(bucket.quantitySum))),
        costMicros: (existing?.costMicros ?? 0n) + bucket.costMicrosSum,
      });
    }

    const points = [...byBucket.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketStartMs, sums]) => ({
        bucketStart: new Date(bucketStartMs).toISOString(),
        quantity: sums.quantity.toFixed(6),
        costMicros: sums.costMicros.toString(),
      }));

    const response = new UsageTimeseriesResponse();
    response.capability = query.capability;
    response.unit = query.unit;
    response.granularity = query.granularity;
    response.from = query.from.toISOString();
    response.to = query.to.toISOString();
    response.points = points;
    return response;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // getCostPerEncounter
  // ═════════════════════════════════════════════════════════════════════════

  async getCostPerEncounter(tenantId: string, period: string): Promise<CostPerEncounterResponse> {
    const billingPeriod = parseBillingPeriod(period);
    const rows = await this.aggregateRepository.sumCostPerConsultation(tenantId, billingPeriod.start, billingPeriod.end);
    const distribution = computeCostDistribution(rows.map((row) => row.costMicros));

    const response = new CostPerEncounterResponse();
    response.period = period;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.count = distribution.count;
    response.p50Micros = distribution.p50Micros;
    response.p90Micros = distribution.p90Micros;
    response.p99Micros = distribution.p99Micros;
    response.meanMicros = distribution.meanMicros;
    response.totalMicros = distribution.totalMicros;
    return response;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // getTopTenants (GLOBAL-ADMIN-only cross-tenant)
  // ═════════════════════════════════════════════════════════════════════════

  // AUTH-NOTE: getTopTenants is GLOBAL-ADMIN-ONLY, enforced imperatively
  // (`isSuperAdmin`) because it deliberately bypasses tenant scope — the
  // permission decorator on the controller route cannot express "and also
  // read every other tenant's rows" (rule 05). Deliberate 403 privilege
  // boundary; every other method on this service stays 404-over-403.
  async getTopTenants(period: string, query: TopTenantsQuery): Promise<TopTenantsResponse> {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Cross-tenant usage rankings are restricted to global administrators.');
    }
    const billingPeriod = parseBillingPeriod(period);
    const rows = await this.aggregateRepository.topTenantsByCost(billingPeriod.start, billingPeriod.end, query.limit, query.capability);

    const response = new TopTenantsResponse();
    response.period = period;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.metric = 'cost';
    response.tenants = rows.map((row): TopTenantUsage => ({ tenantId: row.tenantId, costMicros: row.costMicros.toString() }));
    return response;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // getBudgetBurndown
  // ═════════════════════════════════════════════════════════════════════════

  async getBudgetBurndown(tenantId: string, period: string): Promise<BudgetBurndownResponse> {
    const billingPeriod = parseBillingPeriod(period);
    const now = new Date();
    const usageUntil = new Date(Math.min(now.getTime(), billingPeriod.end.getTime()));

    let plan;
    try {
      const tenant = await this.tenantRepository.findById(tenantId);
      plan = tenant.plan ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) throw new NotFoundException(`Tenant ${tenantId} not found`);
      throw err;
    }

    const planRow = plan ? await this.planEntitlementRepository.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);
    const resolved = resolveBillingAllowances(plan, planRow, override);

    const rollups =
      usageUntil.getTime() > billingPeriod.start.getTime()
        ? await this.rollupDailyRepository.findByPeriod(tenantId, billingPeriod.start, usageUntil)
        : [];

    const usedByCapability = new Map<AiCapability, Decimal>();
    for (const capability of Object.values(AiCapability)) usedByCapability.set(capability, new Decimal(0));
    for (const rollup of rollups) {
      usedByCapability.set(
        rollup.capability,
        (usedByCapability.get(rollup.capability) ?? new Decimal(0)).plus(new Decimal(String(rollup.quantitySum))),
      );
    }

    const totalPeriodMs = billingPeriod.end.getTime() - billingPeriod.start.getTime();
    const elapsedMs = Math.max(0, usageUntil.getTime() - billingPeriod.start.getTime());
    const fractionElapsed = totalPeriodMs > 0 ? elapsedMs / totalPeriodMs : 0;

    const capabilities: CapabilityBurndownLine[] = Object.values(AiCapability).map((capability) =>
      projectCapabilityBurndown(capability, usedByCapability.get(capability) ?? new Decimal(0), resolved.allowances[capability], fractionElapsed),
    );

    const response = new BudgetBurndownResponse();
    response.period = period;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.fractionElapsed = Math.max(fractionElapsed, 1e-9);
    response.computedAt = now.toISOString();
    response.capabilities = capabilities;
    return response;
  }
}
