import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { AiUsageOutboxStatus, CoreDatabaseService } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import {
  PRUNE_BATCH_SIZE,
  PRUNE_CRON_KEY,
  PRUNE_DEFAULTS,
  PRUNE_ENABLED_KEY,
  PRUNE_JOB_NAME,
  PRUNE_MAX_BATCHES_PER_RUN,
  PRUNE_RETENTION_DAYS_KEY,
} from './usage-ledger.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface UsageOutboxPruneConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
}

export interface UsageOutboxPruneResult {
  cutoff: Date;
  totalDeleted: number;
  batches: number;
}

/**
 * Prunes `AiUsageOutbox` rows that have already been drained (`status:
 * DISPATCHED`) and are older than a configurable retention window (WS-B
 * handoff, ws-b-contract.md §11: "Outbox retention/pruning for DISPATCHED
 * rows. | Owner: ").
 *
 * `AiUsageOutboxRepository`'s own doc comment already frames the model this
 * way: "Rows are WORK ITEMS, not history: append-only, no soft delete
 * (drained rows are pruned), no sys-events." A DISPATCHED row has done its
 * job — the durable record of the usage event is the `AiUsageEvent` it
 * produced, not the outbox row itself — so this is a genuine HARD delete,
 * the same posture `AuditRetentionService` takes for expired `AuditLog` rows
 * (whose exact shape this class mirrors, including the config source, the
 * `@OnEvent('app-settings.cache-refreshed')` re-sync, and the OFF-by-default
 * kill switch).
 *
 * Only `DISPATCHED` rows are ever eligible — `PENDING` (still owed) and
 * `FAILED` (parked for a human) rows are never touched by this job,
 * regardless of age.
 */
@Injectable()
export class UsageOutboxPrunerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageOutboxPrunerService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    // Platform-wide maintenance job with no CLS tenant context — same
    // sanctioned escape hatch `AuditRetentionService` uses for its purge.
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

  getConfig(): UsageOutboxPruneConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>(PRUNE_ENABLED_KEY, PRUNE_DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>(PRUNE_CRON_KEY, PRUNE_DEFAULTS.cron),
      retentionDays: this.appSettingsService.getValueWithDefault<number>(PRUNE_RETENTION_DAYS_KEY, PRUNE_DEFAULTS.retentionDays),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Usage-outbox pruning disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  async handleScheduledPrune(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Usage-outbox pruning is disabled — skipping tick');
      return;
    }

    try {
      const result = await this.pruneDispatched();
      this.logger.log({
        message: 'metering.outbox_prune.completed',
        cutoff: result.cutoff.toISOString(),
        totalDeleted: result.totalDeleted,
        batches: result.batches,
      });
    } catch (error) {
      this.logger.error(`Usage-outbox pruning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Hard-deletes `DISPATCHED` `AiUsageOutbox` rows whose `updatedAt` (the
   * drainer stamps this the moment it flips the row to `DISPATCHED` — there
   * is no separate `dispatchedAt` column) is older than `now - retentionDays`.
   * Batched like `AuditRetentionService.purgeExpired`: select a page of
   * eligible ids oldest-first, delete by id, repeat, bounded by
   * `PRUNE_MAX_BATCHES_PER_RUN` so a large backlog never runs as one
   * unbounded transaction.
   */
  async pruneDispatched(): Promise<UsageOutboxPruneResult> {
    const { retentionDays } = this.getConfig();
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

    if (retentionDays < 1) {
      this.logger.warn({ message: 'Usage-outbox retention window is non-positive — refusing to prune', retentionDays });
      return { cutoff, totalDeleted: 0, batches: 0 };
    }

    const outbox = this.databaseService.baseClient.aiUsageOutbox;

    let totalDeleted = 0;
    let batches = 0;

    while (batches < PRUNE_MAX_BATCHES_PER_RUN) {
      const expired = await outbox.findMany({
        where: { status: AiUsageOutboxStatus.DISPATCHED, updatedAt: { lt: cutoff } },
        select: { id: true },
        take: PRUNE_BATCH_SIZE,
        orderBy: { updatedAt: 'asc' },
      });

      if (expired.length === 0) {
        break;
      }

      const { count } = await outbox.deleteMany({
        where: { id: { in: expired.map((row: { id: string }) => row.id) } },
      });

      totalDeleted += count;
      batches += 1;

      if (expired.length < PRUNE_BATCH_SIZE) {
        break;
      }
    }

    return { cutoff, totalDeleted, batches };
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledPrune();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob type is narrower than the `cron` package's runtime type
      this.schedulerRegistry.addCronJob(PRUNE_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Usage-outbox pruning cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule usage-outbox pruning cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(PRUNE_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(PRUNE_JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop.
    }
    this.activeCron = null;
  }
}
