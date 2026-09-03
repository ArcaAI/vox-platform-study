import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { AiCapability, AiUsageUnit, CoreDatabaseService, EntityId, UsageMeterMetric } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IMeteringService, MeterUsage } from './IMeteringService';
import { currentMonthWindow } from './metering-window';
import { METERING_CRON_KEY, METERING_DEFAULTS, METERING_ENABLED_KEY, METERING_JOB_NAME } from './metering.constants';

const MS_PER_MINUTE = 60_000;

/** All five billable token kinds — the "all token kinds summed" definition of LLM_TOKENS/EMBEDDING_TOKENS. */
const TOKEN_UNITS: AiUsageUnit[] = [
  AiUsageUnit.INPUT_TOKEN,
  AiUsageUnit.OUTPUT_TOKEN,
  AiUsageUnit.CACHE_READ_TOKEN,
  AiUsageUnit.CACHE_WRITE_TOKEN,
  AiUsageUnit.REASONING_TOKEN,
];

/** operation strings on `AiUsageEvent` — `string` columns (WS-B vocabulary), not enum re-exports. */
const GUARDRAIL_OPERATION = 'guardrail.validate';
const HARNESS_OPERATION = 'harness.step';

/**
 * LLM operations metered for COGS but NEVER counted toward the tenant-billable
 * LLM_TOKENS meter (D16): guardrail is platform-mandated safety and harness is
 * internal agentic COGS — neither is ever quota-blocked or invoiced. Excluded
 * from the LLM_TOKENS sum now that `AiUsageRollupDaily` carries `operation`
 * ; before the dimension existed the meter over-counted by these.
 */
const NON_BILLABLE_LLM_OPERATIONS: string[] = [GUARDRAIL_OPERATION, HARNESS_OPERATION];

/**
 * `Prisma.Decimal` (decimal.js) out of `aggregate({_sum})`, a plain number in
 * tests, or `null` when a window has no rows. Never `Number(decimalInstance)`
 * directly here — go through `.toNumber()` when it exists so this stays exact
 * for a real Decimal and still accepts a bare mock number in tests.
 */
function toNumberSafe(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

/**
 * Rolling-monthly metering.
 *
 * READS are a live Postgres aggregate over the current UTC calendar-month
 * window ({@link getCurrentUsage}) — authoritative and near-realtime, so the
 * capability snapshot (and, later, enforcement prechecks) is correct even with
 * the reconcile job off. The self-scheduling reconcile job PERSISTS those
 * aggregates into `TenantUsageMeter` (history + a future fast-path); it mirrors
 * {@link AuditRetentionService} exactly — config from {@link IAppSettingsService},
 * re-synced on `app-settings.cache-refreshed`, OFF by default.
 *
 * Every query is cross-tenant-safe (explicit `tenantId` filter on the UNSCOPED
 * `baseClient`) so the job runs with no CLS tenant context and the meter
 * upsert never trips the tenant-scope guard — the same escape hatch the audit
 * retention purge uses. New months open fresh windows automatically (the meter
 * row is keyed by `periodStart`), so there is no destructive reset (Q10-safe).
 */
@Injectable()
export class MeteringService implements IMeteringService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeteringService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {}

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

  // ── Reads (live aggregate; always on, never depends on the job) ──────────

  async getCurrentUsage(tenantId: EntityId, now: Date = new Date()): Promise<MeterUsage> {
    const { periodStart, periodEnd } = currentMonthWindow(now);
    return this.aggregateWindow(tenantId, periodStart, periodEnd);
  }

  // ── Reconcile (persist snapshots; scheduled-job body) ────────────────────

  async reconcileTenant(tenantId: EntityId, now: Date = new Date()): Promise<MeterUsage> {
    const { periodStart, periodEnd } = currentMonthWindow(now);
    const usage = await this.aggregateWindow(tenantId, periodStart, periodEnd);

    await Promise.all([
      this.upsertMeter(tenantId, UsageMeterMetric.CONSULTATIONS, periodStart, periodEnd, usage.consultations, now),
      this.upsertMeter(tenantId, UsageMeterMetric.TRANSCRIPTION_MINUTES, periodStart, periodEnd, usage.transcriptionMinutes, now),
      this.upsertMeter(tenantId, UsageMeterMetric.SUMMARIES, periodStart, periodEnd, usage.summaries, now),
      this.upsertMeter(tenantId, UsageMeterMetric.WORKFLOW_INVOCATIONS, periodStart, periodEnd, usage.workflowInvocations, now),
      // The six ledger-derived unit meters, same window, same
      // upsert primitive. GUARDRAIL_CALLS is persisted too (informational —
      // no allowance column reads it, but the reconcile snapshot is a
      // uniform sweep over every UsageMeterMetric, not just the gated ones).
      this.upsertMeter(tenantId, UsageMeterMetric.STT_SESSION_SECONDS, periodStart, periodEnd, usage.sttSessionSeconds, now),
      this.upsertMeter(tenantId, UsageMeterMetric.LLM_TOKENS, periodStart, periodEnd, usage.llmTokens, now),
      this.upsertMeter(tenantId, UsageMeterMetric.TTS_CHARACTERS, periodStart, periodEnd, usage.ttsCharacters, now),
      this.upsertMeter(tenantId, UsageMeterMetric.NLP_TEXT_UNITS, periodStart, periodEnd, usage.nlpTextUnits, now),
      this.upsertMeter(tenantId, UsageMeterMetric.GUARDRAIL_CALLS, periodStart, periodEnd, usage.guardrailCalls, now),
      this.upsertMeter(tenantId, UsageMeterMetric.EMBEDDING_TOKENS, periodStart, periodEnd, usage.embeddingTokens, now),
    ]);

    return usage;
  }

  async reconcileAllActiveTenants(now: Date = new Date()): Promise<{ tenants: number }> {
    // Unscoped read of every tenant id — the job has no CLS tenant context.
    // Reconciling a null-plan/system tenant is harmless (it just records a
    // snapshot; resolution keeps it ungated per Q3), so no special-casing.
    const tenants = await this.databaseService.baseClient.tenant.findMany({ select: { id: true } });

    let count = 0;
    for (const tenant of tenants) {
      try {
        await this.reconcileTenant(tenant.id, now);
        count += 1;
      } catch (error) {
        this.logger.error(`Metering reconcile failed for tenant ${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { tenants: count };
  }

  // ── Config + scheduling (mirror AuditRetentionService) ───────────────────

  getConfig(): { enabled: boolean; cron: string } {
    return {
      enabled: this.appSettings.getValueWithDefault<boolean>(METERING_ENABLED_KEY, METERING_DEFAULTS.enabled),
      cron: this.appSettings.getValueWithDefault<string>(METERING_CRON_KEY, METERING_DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async handleScheduledReconcile(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Metering reconcile is disabled — skipping tick');
      return;
    }

    try {
      const { tenants } = await this.reconcileAllActiveTenants();
      this.logger.log({ message: 'Metering reconcile completed', tenants });
    } catch (error) {
      this.logger.error(`Metering reconcile tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Metering reconcile disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The authoritative per-window aggregate. Mirrors `TenantService.getUsageStats`
   * roll-ups but bounded to the window and read off the unscoped base client:
   *   - CONSULTATIONS = COUNT(Consultation WHERE createdAt ∈ window)
   *   - TRANSCRIPTION_MINUTES = round(SUM(AudioRecording.duration ms ∈ window)/60000)
   *   - SUMMARIES = COUNT(SummaryMeta WHERE generatedAt ∈ window)
   * WORKFLOW_INVOCATIONS = COUNT(WorkflowRun WHERE startedAt ∈ window)
   *
   * Six more, all read from `AiUsageRollupDaily` (D5) EXCEPT
   * `guardrailCalls` (raw ledger — see `MeterUsage`'s doc comment for why).
   * The daily rollup is never behind the hourly one for "today": the outbox
   * drainer increments BOTH in the SAME transaction on every drain pass
   * (`usage-outbox.drainer.ts#accumulateRollups`), so Daily already carries
   * today's partial-day bucket as of the last drain tick — there is no
   * "fall back to Hourly" case to implement.
   */
  private async aggregateWindow(tenantId: EntityId, periodStart: Date, periodEnd: Date): Promise<MeterUsage> {
    const client = this.databaseService.baseClient;
    const window = { gte: periodStart, lt: periodEnd };

    const [
      consultations,
      durationAgg,
      summaries,
      workflowInvocations,
      sttSessionSeconds,
      llmTokens,
      ttsCharacters,
      nlpTextUnits,
      embeddingTokens,
      guardrailCalls,
    ] = await Promise.all([
      client.consultation.count({ where: { tenantId, createdAt: window } }),
      client.audioRecording.aggregate({ _sum: { duration: true }, where: { tenantId, createdAt: window } }),
      client.summaryMeta.count({ where: { tenantId, generatedAt: window } }),
      // WORKFLOW_INVOCATIONS — COUNT(WorkflowRun WHERE startedAt ∈ window),
      // the same business-object shape as consultations/summaries.
      client.workflowRun.count({ where: { tenantId, startedAt: window } }),
      this.sumRollupQuantity(tenantId, window, AiCapability.STT, [AiUsageUnit.SESSION_SECOND]),
      // LLM_TOKENS bills ONLY generation/pre-summary operations — guardrail and
      // harness LLM rows share the LLM capability but must never count (D16).
      this.sumRollupQuantity(tenantId, window, AiCapability.LLM, TOKEN_UNITS, NON_BILLABLE_LLM_OPERATIONS),
      this.sumRollupQuantity(tenantId, window, AiCapability.TTS, [AiUsageUnit.CHARACTER]),
      this.sumRollupQuantity(tenantId, window, AiCapability.NLP, [AiUsageUnit.TEXT_UNIT]),
      this.sumRollupQuantity(tenantId, window, AiCapability.EMBEDDING, TOKEN_UNITS),
      this.countGuardrailCalls(tenantId, window),
    ]);

    const durationMs = durationAgg._sum.duration ?? 0;

    return {
      consultations,
      transcriptionMinutes: Math.round(durationMs / MS_PER_MINUTE),
      summaries,
      workflowInvocations,
      sttSessionSeconds,
      llmTokens,
      ttsCharacters,
      nlpTextUnits,
      guardrailCalls,
      embeddingTokens,
    };
  }

  /**
   * Sum `AiUsageRollupDaily.quantitySum` for one (capability, unit-set) over
   * the window, rounded to a whole unit (allowances are integer/`BigInt`).
   * `unit` is ALWAYS an `{ in: [...] }` filter, even for a single-unit metric,
   * so every metric reads through one shape.
   */
  private async sumRollupQuantity(
    tenantId: EntityId,
    window: { gte: Date; lt: Date },
    capability: AiCapability,
    units: AiUsageUnit[],
    excludeOperations?: string[],
  ): Promise<number> {
    const result = await this.databaseService.baseClient.aiUsageRollupDaily.aggregate({
      _sum: { quantitySum: true },
      where: {
        tenantId,
        capability,
        unit: { in: units },
        bucketStart: window,
        // Drop COGS-only operations (guardrail/harness) from a
        // billable capability's sum. Omitted entirely when not filtering so the
        // query plan is unchanged for the single-operation capabilities.
        ...(excludeOperations && excludeOperations.length > 0 ? { operation: { notIn: excludeOperations } } : {}),
      },
    });
    return Math.round(toNumberSafe(result._sum.quantitySum));
  }

  /**
   * GUARDRAIL_CALLS — distinct-`requestId` COUNT over the raw `AiUsageEvent`
   * ledger for `operation: 'guardrail.validate'` (capability `LLM`). The
   * rollup cannot answer this (no `operation` dimension — see `MeterUsage`'s
   * doc comment); this is the one metric in this file that reads the raw
   * ledger rather than a pre-aggregate. Acceptable here because GUARDRAIL_CALLS
   * is informational-only (D6/D16 — no allowance column ever gates it, so this
   * never runs on the `assertMeterQuota` hot path) and scoped by the same
   * `(tenantId, occurredAt)` index the ledger's period scans already use.
   */
  private async countGuardrailCalls(tenantId: EntityId, window: { gte: Date; lt: Date }): Promise<number> {
    const rows = await this.databaseService.baseClient.aiUsageEvent.findMany({
      where: { tenantId, capability: AiCapability.LLM, operation: GUARDRAIL_OPERATION, occurredAt: window },
      select: { requestId: true },
      distinct: ['requestId'],
    });
    return rows.length;
  }

  /** Idempotent per-(tenant, metric, window) snapshot upsert (unscoped). */
  private async upsertMeter(
    tenantId: EntityId,
    metric: UsageMeterMetric,
    periodStart: Date,
    periodEnd: Date,
    usedCount: number,
    reconciledAt: Date,
  ): Promise<void> {
    // usedCount is a BigInt column — the aggregates arrive as
    // rounded integers, safely below Number.MAX_SAFE_INTEGER, so BigInt() is
    // exact; the widened column only removes the Int32 ceiling at the DB.
    const usedCountBig = BigInt(usedCount);
    await this.databaseService.baseClient.tenantUsageMeter.upsert({
      where: { TenantUsageMeter_tenant_metric_period_unique: { tenantId, metric, periodStart } },
      create: { tenantId, metric, periodStart, periodEnd, usedCount: usedCountBig, reconciledAt },
      update: { usedCount: usedCountBig, periodEnd, reconciledAt },
    });
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledReconcile();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(METERING_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Metering reconcile cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule metering reconcile cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(METERING_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(METERING_JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop.
    }
    this.activeCron = null;
  }
}
