import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { CoreDatabaseService } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';

const JOB_NAME = 'dna-profile-retention';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Defaults for the DNA writing-style profile retention purge. Catalogued as
 * `dna-profile-retention.*` in `settings-registry/descriptors/platform-ops.descriptors.ts`.
 *
 * `enabled` is OFF by default: the purge HARD-DELETES rows, so an operator
 * must explicitly opt in (and review the window) before any data is removed
 * — the same posture as {@link AuditRetentionService} /
 * {@link AgentTrajectoryRetentionService}.
 */
const DEFAULTS = {
  enabled: false,
  cron: '45 3 * * *',
  retentionDays: 30,
  batchSize: 200,
  maxBatchesPerRun: 100,
} as const;

export interface DnaProfileRetentionConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  batchSize: number;
  maxBatchesPerRun: number;
}

export interface DnaProfileRetentionResult {
  cutoff: Date;
  totalReportsDeleted: number;
  totalVersionsDeleted: number;
  batches: number;
}

/**
 * TASK-733 Task 10 (owner ruling, 2026-08-20) — the "purge later" half of DNA
 * writing-style profile governance.
 *
 * `DnaWritingStyleService.resetMyDnaProfile()` / `.deleteReport()` already
 * soft-delete a clinician's profile IMMEDIATELY (rule 03's default —
 * `resourceStatus: DELETED`), which is the reversible, audited write the rest
 * of the domain uses. That is deliberately NOT "really gone": the profile is
 * derived from PHI, and INV-240 ("the clinician can delete it") must
 * eventually mean the ciphertext is actually erased, not merely hidden behind
 * a status flag forever.
 *
 * This service is that eventual half: a scheduled sweep that HARD-DELETES
 * `DnaWritingStyleReport` rows already soft-deleted for longer than the
 * configured retention window, together with every `DnaWritingStyleVersion`
 * row that belongs to them. Hard delete here is the ONE sanctioned exception
 * to rule 03's soft-delete default (`03-domain-layer.md`: "delete() ...
 * reserved for genuinely immutable cleanup") — a retention purge past an
 * already-soft-deleted, already-audited row is exactly that case, and it is
 * the same exception `AuditRetentionService`/`AgentTrajectoryRetentionService`
 * already rely on.
 *
 * `DnaWritingStyleVersion` carries NO `resourceStatus` column at all
 * (`MODELS_WITHOUT_SOFT_DELETE` — `packages/database/src/client.ts`), so it
 * was never soft-deletable in the first place; its rows become unreachable
 * the instant the parent report is soft-deleted (every version read path —
 * `getVersions`/`getVersionsForDoctor` — loads the parent report FIRST and
 * 404s once it is gone). This sweep is therefore the only place they are
 * ever deleted, and it deletes them in the SAME pass as their parent report
 * — never earlier, so the retention window is honoured for both.
 *
 * Self-scheduling, mirroring {@link AuditRetentionService} /
 * {@link AgentTrajectoryRetentionService} / {@link ConsultationTimeoutSweepService}:
 * a `SchedulerRegistry` cron job that re-syncs whenever the `GlobalSetting`
 * cache refreshes (`@OnEvent('app-settings.cache-refreshed')`), so the
 * enable flag, cadence and retention window are all tunable live, with no
 * redeploy. Uses the UNSCOPED `baseClient` (like `AuditRetentionService`):
 * this is a platform-wide, tenant-less maintenance job, and — critically —
 * the tenant-scoped extended client filters OUT `resourceStatus: DELETED`
 * rows on every read, which would make the very rows this sweep exists to
 * find invisible to it.
 */
@Injectable()
export class DnaProfileRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnaProfileRetentionService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {}

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  /**
   * Reacts to `AppSettingsService` cache refreshes (every ~45s).
   * Compares the live config against the running cron and adjusts.
   */
  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  getConfig(): DnaProfileRetentionConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('dna-profile-retention.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('dna-profile-retention.cron', DEFAULTS.cron),
      retentionDays: this.appSettingsService.getValueWithDefault<number>('dna-profile-retention.retention-days', DEFAULTS.retentionDays),
      batchSize: this.appSettingsService.getValueWithDefault<number>('dna-profile-retention.batch-size', DEFAULTS.batchSize),
      maxBatchesPerRun: this.appSettingsService.getValueWithDefault<number>('dna-profile-retention.max-batches-per-run', DEFAULTS.maxBatchesPerRun),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  /**
   * Reads config from `AppSettingsService` and ensures the running cron job
   * matches. Creates, replaces, or removes the job as needed.
   */
  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('DNA profile retention disabled via settings — stopping scheduler');
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
      this.logger.debug('DNA profile retention is disabled — skipping tick');
      return;
    }

    this.logger.log('Starting scheduled DNA profile retention purge');

    try {
      const result = await this.purgeExpired();
      this.logger.log({
        message: 'DNA profile retention purge completed',
        cutoff: result.cutoff.toISOString(),
        totalReportsDeleted: result.totalReportsDeleted,
        totalVersionsDeleted: result.totalVersionsDeleted,
        batches: result.batches,
      });
    } catch (error) {
      this.logger.error(`DNA profile retention purge failed: ${error}`);
    }
  }

  /**
   * Hard-deletes `DnaWritingStyleReport` rows whose `resourceStatus` is
   * `DELETED` and whose `resourceStatusUpdatedAt` is older than
   * `now - retentionDays`, together with every `DnaWritingStyleVersion` row
   * that belongs to them. Deletes in bounded batches (select a page of
   * expired report ids, delete their versions, then delete the reports
   * themselves) so a large first purge never runs as one unbounded,
   * long-locking transaction; `maxBatchesPerRun` caps a single run.
   *
   * Versions are deleted BEFORE their parent report in every batch, so an
   * interrupted run never leaves an orphaned version row pointing at an
   * already-purged report.
   */
  async purgeExpired(): Promise<DnaProfileRetentionResult> {
    const { retentionDays, batchSize, maxBatchesPerRun } = this.getConfig();
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

    // Safety guard, mirroring `AuditRetentionService.purgeExpired`: a
    // non-positive window would set the cutoff at (or after) "now" and sweep
    // every soft-deleted profile in the platform in one tick.
    if (retentionDays < 1) {
      this.logger.warn({
        message: 'DNA profile retention window is non-positive — refusing to purge',
        retentionDays,
      });
      return { cutoff, totalReportsDeleted: 0, totalVersionsDeleted: 0, batches: 0 };
    }

    const reportDelegate = this.databaseService.baseClient.dnaWritingStyleReport;
    const versionDelegate = this.databaseService.baseClient.dnaWritingStyleVersion;

    let totalReportsDeleted = 0;
    let totalVersionsDeleted = 0;
    let batches = 0;

    while (batches < maxBatchesPerRun) {
      const expired = await reportDelegate.findMany({
        where: { resourceStatus: 'DELETED', resourceStatusUpdatedAt: { lt: cutoff } },
        select: { id: true },
        take: batchSize,
        orderBy: { resourceStatusUpdatedAt: 'asc' },
      });

      if (expired.length === 0) {
        break;
      }

      const ids = expired.map((row: { id: string }) => row.id);

      const { count: versionsDeleted } = await versionDelegate.deleteMany({
        where: { dnaReportId: { in: ids } },
      });
      const { count: reportsDeleted } = await reportDelegate.deleteMany({
        where: { id: { in: ids } },
      });

      totalVersionsDeleted += versionsDeleted;
      totalReportsDeleted += reportsDeleted;
      batches += 1;

      // Drained: the last page was smaller than a full batch.
      if (expired.length < batchSize) {
        break;
      }
    }

    return { cutoff, totalReportsDeleted, totalVersionsDeleted, batches };
  }

  // ── Private helpers ──────────────────────────────────────────

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledPurge();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob generic doesn't line up with the `cron` package's own CronJob type; mirrors the identical cast in the sibling retention schedulers
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'DNA profile retention cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule DNA profile retention cron job',
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
