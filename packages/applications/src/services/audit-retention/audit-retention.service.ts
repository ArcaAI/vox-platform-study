import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { CoreDatabaseService } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';

const JOB_NAME = 'audit-log-retention';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * TASK-336 OB-05 / TH6 — defaults for the AuditLog retention purge.
 *
 * `enabled` is OFF by default: retention HARD-DELETES audit rows, so an
 * operator must explicitly opt in (and review the window) before any data is
 * removed. The window default of 365 days is a starting point only — set
 * `audit-retention.retention-days` per the deployment's compliance policy
 * (e.g. HIPAA audit-trail retention).
 */
const DEFAULTS = {
  enabled: false,
  cron: '0 3 * * *',
  retentionDays: 365,
  batchSize: 1000,
  maxBatchesPerRun: 1000,
} as const;

export interface AuditRetentionConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  batchSize: number;
  maxBatchesPerRun: number;
}

export interface AuditRetentionResult {
  cutoff: Date;
  totalDeleted: number;
  batches: number;
}

/**
 * TASK-336 OB-05 / TH6 — bounds unbounded `AuditLog` growth by purging rows
 * older than a configurable retention window on a schedule.
 *
 * Mirrors the {@link DnaRegenerationScheduler} pattern: a self-scheduling
 * service that reads its config from {@link IAppSettingsService} (DB-backed
 * `GlobalSetting` cache, with the code DEFAULTS above as the fallback) and
 * re-syncs its cron whenever the settings cache refreshes
 * (`@OnEvent('app-settings.cache-refreshed')`), so the window/cron/enable flag
 * can be tuned live without a redeploy.
 *
 * The actual delete is intentionally a HARD delete (soft-delete would keep the
 * rows and so would NOT bound growth). This is the sanctioned automated
 * retention path called out in OB-10 — distinct from ad-hoc admin deletion.
 */
@Injectable()
export class AuditRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    // TASK-336 OB-05 — retention is a platform-wide, tenant-less maintenance
    // job, so it must use the UNSCOPED base client: the tenant-scope `$extends`
    // would (a) reject the write with "tenant context required for model
    // AuditLog" since the scheduler runs with no CLS tenant, and (b) only ever
    // see the current tenant's rows. `baseClient` is the sanctioned escape
    // hatch for hard deletes + cross-tenant maintenance (see its JSDoc), the
    // same one AuditLogService uses for the pre-auth LOGIN audit write.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {}

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  /**
   * Reacts to AppSettingsService cache refreshes (every ~45 s).
   * Compares the live config against the running cron and adjusts.
   */
  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  getConfig(): AuditRetentionConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('audit-retention.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('audit-retention.cron', DEFAULTS.cron),
      retentionDays: this.appSettingsService.getValueWithDefault<number>('audit-retention.retention-days', DEFAULTS.retentionDays),
      batchSize: this.appSettingsService.getValueWithDefault<number>('audit-retention.batch-size', DEFAULTS.batchSize),
      maxBatchesPerRun: this.appSettingsService.getValueWithDefault<number>('audit-retention.max-batches-per-run', DEFAULTS.maxBatchesPerRun),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  /**
   * Reads config from AppSettingsService and ensures the running cron job
   * matches. Creates, replaces, or removes the job as needed.
   */
  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Audit-log retention disabled via settings — stopping scheduler');
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
   * The callback executed by the cron job on each tick.
   */
  async handleScheduledPurge(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Audit-log retention is disabled — skipping tick');
      return;
    }

    this.logger.log('Starting scheduled audit-log retention purge');

    try {
      const result = await this.purgeExpired();
      this.logger.log({
        message: 'Audit-log retention purge completed',
        cutoff: result.cutoff.toISOString(),
        totalDeleted: result.totalDeleted,
        batches: result.batches,
      });
    } catch (error) {
      this.logger.error(`Audit-log retention purge failed: ${error}`);
    }
  }

  /**
   * Hard-deletes `AuditLog` rows whose `createdAt` is older than
   * `now - retentionDays`. Deletes in bounded batches (select a page of expired
   * ids via the `AuditLog_createdAt_idx` index, then delete them by primary
   * key) so a large first purge never runs as one unbounded, long-locking
   * transaction; `maxBatchesPerRun` caps a single run.
   */
  async purgeExpired(): Promise<AuditRetentionResult> {
    const { retentionDays, batchSize, maxBatchesPerRun } = this.getConfig();
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

    // Safety guard: a non-positive window would set the cutoff at (or after)
    // "now" and purge the entire table. Refuse rather than risk a catastrophic
    // delete from a misconfigured setting.
    if (retentionDays < 1) {
      this.logger.warn({
        message: 'Audit-log retention window is non-positive — refusing to purge',
        retentionDays,
      });
      return { cutoff, totalDeleted: 0, batches: 0 };
    }

    const auditLog = this.databaseService.baseClient.auditLog;

    let totalDeleted = 0;
    let batches = 0;

    while (batches < maxBatchesPerRun) {
      const expired = await auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });

      if (expired.length === 0) {
        break;
      }

      const { count } = await auditLog.deleteMany({
        where: { id: { in: expired.map((row: { id: string }) => row.id) } },
      });

      totalDeleted += count;
      batches += 1;

      // Drained: the last page was smaller than a full batch.
      if (expired.length < batchSize) {
        break;
      }
    }

    return { cutoff, totalDeleted, batches };
  }

  // ── Private helpers ──────────────────────────────────────────

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledPurge();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Audit-log retention cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule audit-log retention cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop
    }
    this.activeCron = null;
  }
}
