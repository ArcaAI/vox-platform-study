import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { AiCapability, AiDeploymentKind, AiUsageUnit, CoreDatabaseService, EntityId, UsageMeterMetric } from '@arcaai/domains';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { currentMonthWindow } from '../metering-window';
import { computeDrift, computeDriftReport, DriftComparison } from './drift-math';
import { buildProviderReconcilerRegistry, summarizeAvailability } from './provider-reconciler-registry';
import { formatWindowLabel, resolveReconciliationWindow } from './provider-reconciliation-window';
import type { ProviderReconcilerAvailability } from './provider-reconciler';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IShadowMeteringService } from './IShadowMeteringService';
import { ProviderReconciliationResult, ProviderReconciliationSweepResult, ShadowMeteringSweepResult, TenantDriftReport } from './dto/drift-report';
import {
  RECONCILED_METER_METRICS,
  SHADOW_METERING_CRON_KEY,
  SHADOW_METERING_DEFAULTS,
  PROVIDER_DRIFT_DETECTED_EVENT,
  SHADOW_METERING_DRIFT_DETECTED_EVENT,
  SHADOW_METERING_DRIFT_THRESHOLD_PCT,
  SHADOW_METERING_ENABLED_KEY,
  SHADOW_METERING_JOB_NAME,
  SHADOW_TOKEN_UNITS,
} from './shadow-metering.constants';

/** `Prisma.Decimal` (decimal.js) out of `aggregate({_sum})`, a plain number in tests, or `null` — mirrors `metering.service.ts#toNumberSafe`. */
function toNumberSafe(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

/**
 * Shadow-metering reconciliation report (TASK-615 WS-K).
 *
 * Read-only, self-scheduling, OFF by default — see
 * `shadow-metering.constants.ts` for the full design rationale. Structured
 * logging on every run (the `structlog`-equivalent this monorepo's TS side
 * uses is `@arcaai/logger`'s Nest `Logger` with an object payload); a
 * `SHADOW_METERING_DRIFT_DETECTED_EVENT` fires per tenant whose report
 * contains at least one breach so a future subscriber can persist an audit
 * row (this lane does not own `sysEvent.service.ts` — wiring a handler there
 * is a follow-up, not part of WS-K's file ownership).
 */
@Injectable()
export class ShadowMeteringService implements IShadowMeteringService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShadowMeteringService.name);
  private activeCron: string | null = null;
  private readonly providerRegistry = buildProviderReconcilerRegistry((key) => this.lookupSecret(key));

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional so the service still constructs (and the sweep still runs, with
    // every provider reported unavailable) in a deployment with no secrets
    // backend wired — §6 rule 7, fail open.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /** Vault-backed credential resolution for the provider reconcilers. */
  private async lookupSecret(key: string): Promise<string | undefined> {
    return this.secretsService?.getSecretOptional(key);
  }

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async runForTenant(tenantId: EntityId, now: Date = new Date()): Promise<TenantDriftReport> {
    const { periodStart, periodEnd } = currentMonthWindow(now);
    const window = { gte: periodStart, lt: periodEnd };

    const comparisons: DriftComparison[] = [];

    // ── Surface 1: ledger LLM tokens vs SummaryMeta token columns ─────────
    // Known, documented drift source (WS-H handoff): the ledger's LLM_TOKENS
    // rollup also carries `guardrail.validate` and `harness.step` rows (D16 —
    // metered for COGS, never SMR-attributed), so the ledger total is
    // EXPECTED to run higher than SummaryMeta's SMR-only capture. A breach
    // here is not automatically a bug; it is a signal to inspect the
    // decomposition (see `research-findings.md` §6 / ws-b-contract.md §11).
    const [ledgerLlmTokens, summaryMetaTokens] = await Promise.all([
      this.sumRollupQuantity(tenantId, window, AiCapability.LLM, SHADOW_TOKEN_UNITS),
      this.sumSummaryMetaTokens(tenantId, window),
    ]);
    comparisons.push({ label: 'ledger-vs-summaryMeta:LLM_TOKENS', expected: ledgerLlmTokens, actual: summaryMetaTokens });

    // ── Surface 2: persisted TenantUsageMeter snapshot vs a fresh live aggregate ──
    // Same source table for both sides by design (`MeteringService` derives
    // the meter from the same rollup this job re-queries), so a breach here
    // means the persisted snapshot is STALE — the reconcile job stopped
    // running or errored — not a ledger/emission bug.
    for (const metric of RECONCILED_METER_METRICS) {
      const [liveAggregate, persistedMeter] = await Promise.all([
        this.liveAggregateForMetric(tenantId, window, metric),
        this.persistedMeterValue(tenantId, metric, periodStart),
      ]);
      comparisons.push({ label: `ledger-vs-meter:${metric}`, expected: liveAggregate, actual: persistedMeter });
    }

    const { results, breaches } = computeDriftReport(comparisons);

    const report: TenantDriftReport = {
      tenantId,
      periodStart,
      periodEnd,
      comparisons: results,
      breaches,
      providerAvailability: await summarizeAvailability(this.providerRegistry),
    };

    if (breaches.length > 0) {
      this.eventEmitter.emit(SHADOW_METERING_DRIFT_DETECTED_EVENT, {
        tenantId,
        periodStart,
        periodEnd,
        breaches: breaches.map((b) => ({ label: b.label, expected: b.expected, actual: b.actual, relativeDrift: b.relativeDrift })),
      });
    }

    this.logger.log({
      message: 'metering.shadow_report.tenant_completed',
      tenantId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      comparisons: results.length,
      breaches: breaches.length,
    });

    return report;
  }

  async runForAllActiveTenants(now: Date = new Date()): Promise<ShadowMeteringSweepResult> {
    // Unscoped read of every tenant id — mirrors `MeteringService.reconcileAllActiveTenants`.
    const tenants = await this.databaseService.baseClient.tenant.findMany({ select: { id: true } });

    const reports: TenantDriftReport[] = [];
    for (const tenant of tenants) {
      try {
        reports.push(await this.runForTenant(tenant.id, now));
      } catch (error) {
        this.logger.error(`Shadow-metering report failed for tenant ${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const tenantsWithBreaches = reports.filter((r) => r.breaches.length > 0).length;
    const totalBreaches = reports.reduce((sum, r) => sum + r.breaches.length, 0);

    return { tenants: reports.length, tenantsWithBreaches, totalBreaches, reports };
  }

  // ── Config + scheduling (mirrors MeteringService / AuditRetentionService) ──

  getConfig(): { enabled: boolean; cron: string } {
    return {
      enabled: this.appSettings.getValueWithDefault<boolean>(SHADOW_METERING_ENABLED_KEY, SHADOW_METERING_DEFAULTS.enabled),
      cron: this.appSettings.getValueWithDefault<string>(SHADOW_METERING_CRON_KEY, SHADOW_METERING_DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async handleScheduledReport(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Shadow-metering report is disabled — skipping tick');
      return;
    }

    try {
      const result = await this.runForAllActiveTenants();
      this.logger.log({
        message: 'metering.shadow_report.sweep_completed',
        tenants: result.tenants,
        tenantsWithBreaches: result.tenantsWithBreaches,
        totalBreaches: result.totalBreaches,
      });
    } catch (error) {
      this.logger.error(`Shadow-metering report tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Shadow-metering report disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  /**
   * Reconcile the ledger against each provider's own usage/cost report for the
   * last SETTLED window (TASK-638 §6).
   *
   * Four rules are enforced here rather than left to each vendor client:
   *   - **CLOUD only** (rule 2). BYOK runs on the tenant's account, so the
   *     platform is not billed for it and must not expect it in a vendor total;
   *     self-hosted has no vendor bill at all. The ledger side filters on
   *     `deployment: CLOUD` — which is only expressible because TASK-638 put
   *     `deployment` on the rollup grain.
   *   - **Trailing window** (rule 4) — see `provider-reconciliation-window.ts`.
   *   - **Alert, never auto-correct** (rule 5). A breach emits; nothing writes
   *     to the ledger. The ledger is append-only and is corrected by a
   *     compensating event, never by a reconciler deciding the vendor is right.
   *   - **Fail open** (rule 7). A provider that errors is recorded `failed` and
   *     the sweep continues; reconciliation must never block metering.
   */
  async reconcileProviders(now: Date = new Date()): Promise<ProviderReconciliationSweepResult> {
    const window = resolveReconciliationWindow(now);
    const label = formatWindowLabel(window);
    const results: ProviderReconciliationResult[] = [];

    for (const reconciler of this.providerRegistry.values()) {
      const availability: ProviderReconcilerAvailability = await reconciler.checkAvailability();
      if (availability.available === false) {
        results.push({
          provider: reconciler.provider,
          window: label,
          windowStart: window.start,
          windowEnd: window.end,
          status: 'skipped',
          reason: availability.reason,
        });
        continue;
      }

      try {
        const [ledgerQuantity, controlTotal] = await Promise.all([
          this.cloudLedgerControlTotal(reconciler.provider, window),
          reconciler.fetchControlTotal(window.start, window.end),
        ]);

        // `null` = the vendor reports an empty bucket, which is a real answer
        // (0), not an error — comparing it is how a silently-stopped emitter
        // gets caught.
        const providerQuantity = controlTotal?.quantity ?? 0;
        const drift = computeDrift({ label: `ledger-vs-provider:${reconciler.provider}`, expected: ledgerQuantity, actual: providerQuantity });

        results.push({
          provider: reconciler.provider,
          window: label,
          windowStart: window.start,
          windowEnd: window.end,
          status: 'reconciled',
          ledgerQuantity,
          providerQuantity,
          providerUnit: controlTotal?.unit,
          relativeDrift: drift.relativeDrift,
          breachesThreshold: drift.breachesThreshold,
        });

        if (drift.breachesThreshold) {
          this.eventEmitter.emit(PROVIDER_DRIFT_DETECTED_EVENT, {
            provider: reconciler.provider,
            window: label,
            ledgerQuantity,
            providerQuantity,
            relativeDrift: drift.relativeDrift,
            thresholdPct: SHADOW_METERING_DRIFT_THRESHOLD_PCT,
          });
          this.logger.warn({
            message: 'Provider reconciliation drift detected',
            provider: reconciler.provider,
            window: label,
            ledgerQuantity,
            providerQuantity,
            relativeDrift: drift.relativeDrift,
          });
        }
      } catch (error) {
        this.logger.error({
          message: 'Provider reconciliation failed — continuing',
          provider: reconciler.provider,
          window: label,
          error: (error as Error).message,
        });
        results.push({
          provider: reconciler.provider,
          window: label,
          windowStart: window.start,
          windowEnd: window.end,
          status: 'failed',
          reason: (error as Error).message,
        });
      }
    }

    return {
      window: label,
      results,
      reconciled: results.filter((r) => r.status === 'reconciled').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      breaches: results.filter((r) => r.breachesThreshold).length,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async sumRollupQuantity(
    tenantId: EntityId,
    window: { gte: Date; lt: Date },
    capability: AiCapability,
    units: AiUsageUnit[],
  ): Promise<number> {
    const result = await this.databaseService.baseClient.aiUsageRollupDaily.aggregate({
      _sum: { quantitySum: true },
      where: { tenantId, capability, unit: { in: units }, bucketStart: window },
    });
    return Math.round(toNumberSafe(result._sum.quantitySum));
  }

  /**
   * Platform-wide ledger quantity for one provider over the window, CLOUD only.
   *
   * No tenant filter ON PURPOSE — a vendor bills the platform, not a tenant, so
   * the only join that can balance is platform-wide (research-findings §11.2).
   * `deployment: CLOUD` excludes BYOK (tenant-funded) and SELF_HOSTED (no
   * vendor bill), which is the difference between a meaningful comparison and
   * one that is guaranteed to drift.
   */
  private async cloudLedgerControlTotal(provider: string, window: { start: Date; end: Date }): Promise<number> {
    const result = await this.databaseService.baseClient.aiUsageRollupDaily.aggregate({
      _sum: { quantitySum: true },
      where: { provider, deployment: AiDeploymentKind.CLOUD, bucketStart: { gte: window.start, lt: window.end } },
    });
    return Math.round(toNumberSafe(result._sum.quantitySum));
  }

  private async sumSummaryMetaTokens(tenantId: EntityId, window: { gte: Date; lt: Date }): Promise<number> {
    const result = await this.databaseService.baseClient.summaryMeta.aggregate({
      _sum: { inputTokens: true, outputTokens: true },
      where: { tenantId, generatedAt: window },
    });
    return toNumberSafe(result._sum.inputTokens) + toNumberSafe(result._sum.outputTokens);
  }

  /** Live aggregate for one `UsageMeterMetric`, same shape `MeteringService.aggregateWindow` uses — GUARDRAIL_CALLS reads the raw ledger (no `operation` dimension on the rollup), the other five read the rollup. */
  private async liveAggregateForMetric(tenantId: EntityId, window: { gte: Date; lt: Date }, metric: UsageMeterMetric): Promise<number> {
    switch (metric) {
      case UsageMeterMetric.STT_SESSION_SECONDS:
        return this.sumRollupQuantity(tenantId, window, AiCapability.STT, [AiUsageUnit.SESSION_SECOND]);
      case UsageMeterMetric.LLM_TOKENS:
        return this.sumRollupQuantity(tenantId, window, AiCapability.LLM, SHADOW_TOKEN_UNITS);
      case UsageMeterMetric.TTS_CHARACTERS:
        return this.sumRollupQuantity(tenantId, window, AiCapability.TTS, [AiUsageUnit.CHARACTER]);
      case UsageMeterMetric.NLP_TEXT_UNITS:
        return this.sumRollupQuantity(tenantId, window, AiCapability.NLP, [AiUsageUnit.TEXT_UNIT]);
      case UsageMeterMetric.EMBEDDING_TOKENS:
        return this.sumRollupQuantity(tenantId, window, AiCapability.EMBEDDING, SHADOW_TOKEN_UNITS);
      case UsageMeterMetric.GUARDRAIL_CALLS: {
        const rows = await this.databaseService.baseClient.aiUsageEvent.findMany({
          where: { tenantId, capability: AiCapability.LLM, operation: 'guardrail.validate', occurredAt: window },
          select: { requestId: true },
          distinct: ['requestId'],
        });
        return rows.length;
      }
      default:
        return 0;
    }
  }

  private async persistedMeterValue(tenantId: EntityId, metric: UsageMeterMetric, periodStart: Date): Promise<number> {
    const row = await this.databaseService.baseClient.tenantUsageMeter.findUnique({
      where: { TenantUsageMeter_tenant_metric_period_unique: { tenantId, metric, periodStart } },
      select: { usedCount: true },
    });
    return row ? toNumberSafe(row.usedCount) : 0;
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledReport();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob type is narrower than the `cron` package's runtime type
      this.schedulerRegistry.addCronJob(SHADOW_METERING_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Shadow-metering report cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule shadow-metering report cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(SHADOW_METERING_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(SHADOW_METERING_JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop.
    }
    this.activeCron = null;
  }
}
