import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { CoreDatabaseService, EntityId, UsageMeterMetric } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IMeteringService, MeterUsage } from './IMeteringService';
import { currentMonthWindow } from './metering-window';
import { METERING_CRON_KEY, METERING_DEFAULTS, METERING_ENABLED_KEY, METERING_JOB_NAME } from './metering.constants';

const MS_PER_MINUTE = 60_000;

/**
 * TASK-392 (Q5, Phase 2) — rolling-monthly metering.
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
   *   - CONSULTATIONS         = COUNT(Consultation WHERE createdAt ∈ window)
   *   - TRANSCRIPTION_MINUTES = round(SUM(AudioRecording.duration ms ∈ window)/60000)
   *   - SUMMARIES             = COUNT(SummaryMeta WHERE generatedAt ∈ window)
   */
  private async aggregateWindow(tenantId: EntityId, periodStart: Date, periodEnd: Date): Promise<MeterUsage> {
    const client = this.databaseService.baseClient;
    const window = { gte: periodStart, lt: periodEnd };

    const [consultations, durationAgg, summaries] = await Promise.all([
      client.consultation.count({ where: { tenantId, createdAt: window } }),
      client.audioRecording.aggregate({ _sum: { duration: true }, where: { tenantId, createdAt: window } }),
      client.summaryMeta.count({ where: { tenantId, generatedAt: window } }),
    ]);

    const durationMs = durationAgg._sum.duration ?? 0;

    return {
      consultations,
      transcriptionMinutes: Math.round(durationMs / MS_PER_MINUTE),
      summaries,
    };
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
    await this.databaseService.baseClient.tenantUsageMeter.upsert({
      where: { TenantUsageMeter_tenant_metric_period_unique: { tenantId, metric, periodStart } },
      create: { tenantId, metric, periodStart, periodEnd, usedCount, reconciledAt },
      update: { usedCount, periodEnd, reconciledAt },
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
