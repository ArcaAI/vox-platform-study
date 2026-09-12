import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import Decimal from 'decimal.js';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  AiCapability,
  AiUsageRollupDailyRepository,
  AiUsageRollupHourlyRepository,
  AiUsageUnit,
  CoreDatabaseService,
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
import { UsageStorageSnapshotSummary } from './dto';
import { STORAGE_CLASSES, type StorageClass } from '../usageLedger/usage-attributes';
import { MeasurableRollup, QUANTITY_DECIMAL_PLACES, summariseMeasures } from './usage-measures';
import { IUsageAnalyticsService, TopTenantsQuery, UsageTimeseriesQuery } from './IUsageAnalyticsService';
import { projectCapabilityBurndown } from './budget-burndown';
import { computeCostDistribution } from './percentile';
import { validateTimeseriesRange } from './range-bounds';

/**
 * Read-only usage-analytics surface over the ledger rollups.
 *
 * DATA SOURCES — same posture as the invoice engine (D13): reads
 * ROLLUPS, never raw ledger events, for anything that scans a full period.
 * The two exceptions are bounded SQL AGGREGATES (`UsageAnalyticsAggregateRepository`,
 * same rationale as `BillingUsageAggregateRepository`) for the two shapes the
 * rollup dimension tuple cannot express: cost-per-CONSULTATION and
 * cross-TENANT top-N.
 *
 * G16 (CLOSED): `PlatformMetricsService.getConsumptionRollup` now
 * derives `transcriptionMinutes` from the STT `AUDIO_SECOND` rollups
 * (`AiUsageRollupDailyRepository.sumQuantityForCapabilityUnits`), so that field
 * agrees with this module's `getUsageSummary` instead of summing raw
 * `AudioRecording` durations. `summaries24h` deliberately stays on
 * `SummaryMetaRepository`: a summary COUNT has no ledger equivalent (the ledger
 * meters tokens per request, not summary cardinality), so the rollups cannot
 * answer it better. Storage/consultation fields keep their authoritative sources.
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
    // TASK-959. Two reads the ROLLUP grain structurally cannot answer, both
    // bounded and both carrying an explicit `tenantId` predicate:
    //   - the storage snapshot's per-CLASS split, which lives on
    //     `attributesJson.storageClass` and is therefore absent from the rollup
    //     dimension tuple (media and claim-check are BOTH provider `minio`);
    //   - Σ worker CPU for ONE run, keyed on `requestId`, which is likewise not
    //     a rollup dimension.
    // Same escape hatch, and the same justification, as
    // `MeteringService.countGuardrailCalls` — the base client is used because
    // this read must not depend on a CLS tenant, and the tenant is passed
    // explicitly instead.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
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

    const [byokRows, storage] = await Promise.all([
      this.aggregateRepository.sumByokNotionalByCapability(tenantId, billingPeriod.start, billingPeriod.end),
      this.readLatestStorageSnapshot(tenantId, billingPeriod.start, billingPeriod.end),
    ]);
    const byokNotionalCostMicrosByCapability = Object.fromEntries(byokRows.map((row) => [row.capability, row.costMicros.toString()]));

    const response = new UsageSummaryResponse();
    response.period = period;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.lines = lines;
    response.totalCostMicros = totalCostMicros.toString();
    response.byokNotionalCostMicrosByCapability = byokNotionalCostMicrosByCapability;
    // TASK-959 — derived from the SAME rollups already read above.
    const measures = summariseMeasures(rollups);
    response.computeSeconds = measures.computeSeconds;
    response.workflowCpuSeconds = measures.workflowCpuSeconds;
    response.thirdPartyBytes = measures.thirdPartyBytes;
    response.storage = storage;
    return response;
  }

  /**
   * The latest nightly storage snapshot WITHIN the period, split by class.
   *
   * Two bounded reads rather than one: find the most recent snapshot instant,
   * then read that instant's rows. Every class of one snapshot shares an
   * `occurredAt` (the measured day's last millisecond) by construction, so the
   * second read returns at most three rows — while a single `orderBy … take: 3`
   * could straddle two days whenever a class was skipped for holding nothing.
   *
   * Reads the RAW ledger, not the rollup, because the class lives on
   * `attributesJson.storageClass`, which the rollup dimension tuple does not
   * carry — and `provider` cannot substitute for it: media and claim-check are
   * both `minio`. This is the same exception, for the same structural reason, as
   * `MeteringService.countGuardrailCalls`.
   */
  private async readLatestStorageSnapshot(tenantId: string, from: Date, to: Date): Promise<UsageStorageSnapshotSummary | null> {
    const scope = {
      tenantId,
      capability: AiCapability.STORAGE,
      unit: AiUsageUnit.STORAGE_GB_DAY,
    };
    const latest = await this.databaseService.baseClient.aiUsageEvent.findFirst({
      where: { ...scope, occurredAt: { gte: from, lt: to } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    if (!latest) return null;

    const rows = await this.databaseService.baseClient.aiUsageEvent.findMany({
      where: { ...scope, occurredAt: latest.occurredAt },
      select: { quantity: true, attributesJson: true },
    });

    const byClass = new Map<StorageClass, Decimal>(STORAGE_CLASSES.map((storageClass) => [storageClass, new Decimal(0)]));
    for (const row of rows) {
      const storageClass = (row.attributesJson as { storageClass?: StorageClass } | null)?.storageClass;
      if (!storageClass || !byClass.has(storageClass)) continue;
      byClass.set(storageClass, byClass.get(storageClass)!.plus(new Decimal(String(row.quantity))));
    }

    const media = byClass.get('media')!;
    const text = byClass.get('text')!;
    const claimCheck = byClass.get('claim-check')!;

    const summary = new UsageStorageSnapshotSummary();
    summary.mediaGb = media.toFixed(QUANTITY_DECIMAL_PLACES);
    summary.textGb = text.toFixed(QUANTITY_DECIMAL_PLACES);
    summary.claimCheckGb = claimCheck.toFixed(QUANTITY_DECIMAL_PLACES);
    summary.totalGb = media.plus(text).plus(claimCheck).toFixed(QUANTITY_DECIMAL_PLACES);
    summary.asOf = latest.occurredAt.toISOString();
    return summary;
  }

  /**
   * Σ `CPU_SECOND` under capability `WORKFLOW` for ONE run (TASK-959 §3.4).
   *
   * `requestId` IS the run id on those rows, which is why this is answerable at
   * all: the metering interceptor stamps it per activity, so a run's worker CPU
   * is the sum over its own request id. Not a rollup read — `requestId` is not
   * a rollup dimension, and a per-run figure is exactly what a rollup discards.
   *
   * `null`, never 0, when there are no rows: a run that predates the interceptor
   * and a run that burned no measurable CPU are different facts, and only the
   * first is a reason to stop looking for the number.
   */
  async getWorkflowRunCpuSeconds(tenantId: string, runId: string): Promise<number | null> {
    const result = await this.databaseService.baseClient.aiUsageEvent.aggregate({
      _sum: { quantity: true },
      where: { tenantId, capability: AiCapability.WORKFLOW, unit: AiUsageUnit.CPU_SECOND, requestId: runId },
    });
    const sum = result._sum?.quantity ?? null;
    if (sum === null || sum === undefined) return null;
    return typeof sum === 'object' && typeof (sum as { toNumber?: unknown }).toNumber === 'function'
      ? (sum as { toNumber: () => number }).toNumber()
      : Number(sum);
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

    // Every bucket in range gets a point, keyed by its start; the SELECTED
    // (capability, unit) series is filtered per bucket while the TASK-959
    // companion figures are reduced from the bucket's full row set. A bucket
    // that carries only companion rows therefore still appears — with a zeroed
    // selected series — which is the honest answer: the platform spent compute
    // in that hour even though the series being charted did not move.
    const byBucket = new Map<number, { quantity: Decimal; costMicros: bigint; all: MeasurableRollup[] }>();
    for (const bucket of buckets) {
      const key = bucket.bucketStart.getTime();
      const existing = byBucket.get(key) ?? { quantity: new Decimal(0), costMicros: 0n, all: [] };
      const selected = bucket.capability === query.capability && bucket.unit === query.unit;
      byBucket.set(key, {
        quantity: selected ? existing.quantity.plus(new Decimal(String(bucket.quantitySum))) : existing.quantity,
        costMicros: selected ? existing.costMicros + bucket.costMicrosSum : existing.costMicros,
        all: [...existing.all, bucket],
      });
    }

    const points = [...byBucket.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketStartMs, sums]) => {
        const measures = summariseMeasures(sums.all);
        return {
          bucketStart: new Date(bucketStartMs).toISOString(),
          quantity: sums.quantity.toFixed(QUANTITY_DECIMAL_PLACES),
          costMicros: sums.costMicros.toString(),
          computeSeconds: measures.computeSeconds,
          workflowCpuSeconds: measures.workflowCpuSeconds,
          thirdPartyBytes: measures.thirdPartyBytes,
          storageGb: measures.storageGb,
        };
      });

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
  // getTopTenants (SUPER_ADMIN-only cross-tenant)
  // ═════════════════════════════════════════════════════════════════════════

  // AUTH-NOTE: getTopTenants is SUPER_ADMIN-ONLY, enforced imperatively
  // (`isSuperAdmin`) because it deliberately bypasses tenant scope — the
  // permission decorator on the controller route cannot express "and also
  // read every other tenant's rows" (rule 05). Deliberate 403 privilege
  // boundary; every other method on this service stays 404-over-403.
  async getTopTenants(period: string, query: TopTenantsQuery): Promise<TopTenantsResponse> {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Cross-tenant usage rankings are restricted to super administrators.');
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
