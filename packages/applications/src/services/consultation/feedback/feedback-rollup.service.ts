import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationFeedbackDailyRollupFactory,
  ConsultationFeedbackDailyRollupRepository,
  ConsultationFeedbackRepository,
  CoreDatabaseService,
  ResourceStatusType,
  ResourceType,
  TenantRepository,
} from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';

export const FEEDBACK_ROLLUP_CRON_KEY = 'consultation.feedback.rollupCron';
export const FEEDBACK_ROLLUP_LOOKBACK_DAYS_KEY = 'consultation.feedback.rollupLookbackDays';
const DEFAULT_CRON = '30 1 * * *';
const DEFAULT_LOOKBACK_DAYS = 2;
const MAX_LOOKBACK_DAYS = 30;
const JOB_NAME = 'consultation-feedback-rollup';
const LOCK_KEY = 'consultation-feedback-rollup:lock';
const LOCK_TTL_SECONDS = 60 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface FeedbackRollupResult {
  skipped?: 'locked';
  tenants: number;
  tenantsFailed: number;
  days: number;
}

/**
 * Daily feedback rollup. Recomputes the trailing `rollupLookbackDays` UTC days
 * (today included) from the append-only feedback EVENTS and replaces each
 * (tenant, day) in one transaction, so a late event lands in the right day and
 * a day that lost its events is cleared. The rows are dimensions and counts
 * only — no comment, no target id, no text.
 *
 * Self-scheduling like the other retention jobs: the cron is a governed
 * setting re-synced on every settings refresh; replicas each schedule it and a
 * Redis lock keeps one run at a time. The worker has no request context, so
 * each tenant's pass binds the tenant and a worker session in CLS explicitly.
 */
@Injectable()
export class FeedbackRollupService extends BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedbackRollupService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantRepository: TenantRepository,
    private readonly feedbackRepository: ConsultationFeedbackRepository,
    private readonly rollupRepository: ConsultationFeedbackDailyRollupRepository,
    private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationFeedbackRollup);
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

  syncSchedulerFromConfig(): void {
    const cron = this.appSettings.getValueWithDefault<string>(FEEDBACK_ROLLUP_CRON_KEY, DEFAULT_CRON);
    if (cron === this.activeCron) return;
    this.stopJob();
    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledRollup();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;
      this.logger.log({ message: 'Feedback rollup scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({ message: 'Failed to schedule the feedback rollup', cron, error: errorClass(error) });
    }
  }

  async handleScheduledRollup(): Promise<void> {
    try {
      const result = await this.rollupAll();
      this.logger.log({ message: 'Feedback rollup finished', ...result });
    } catch (error) {
      this.logger.error({ message: 'Feedback rollup failed', error: errorClass(error) });
    }
  }

  /** One pass over every enabled tenant. */
  async rollupAll(): Promise<FeedbackRollupResult> {
    const lookback = this.lookbackDays();
    const result: FeedbackRollupResult = { tenants: 0, tenantsFailed: 0, days: lookback };

    if (!(await this.acquireLock())) {
      this.logger.log({ message: 'Feedback rollup already running on another replica; skipped' });
      return { ...result, skipped: 'locked' };
    }

    try {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const from = new Date(today.getTime() - (lookback - 1) * MS_PER_DAY);
      const to = new Date(today.getTime() + MS_PER_DAY);

      const tenants = await this.tenantRepository.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED } });
      result.tenants = tenants.length;
      for (const tenant of tenants) {
        const ok = await this.runAsWorker(tenant.id, () => this.rollupTenant(tenant.id, from, lookback, to));
        if (!ok) result.tenantsFailed += 1;
      }
      return result;
    } finally {
      await this.releaseLock();
    }
  }

  private async rollupTenant(tenantId: string, from: Date, lookback: number, to: Date): Promise<void> {
    const aggregates = await this.feedbackRepository.aggregateEvents(tenantId, from, to);
    const computedAt = new Date();
    for (let i = 0; i < lookback; i += 1) {
      const day = new Date(from.getTime() + i * MS_PER_DAY);
      const rows = aggregates
        .filter((a) => a.day.getTime() === day.getTime())
        .map((a) =>
          ConsultationFeedbackDailyRollupFactory.CreateConsultationFeedbackDailyRollup({
            tenantId,
            day,
            targetKind: a.targetKind,
            agentSlug: a.agentSlug,
            agentVersion: a.agentVersion,
            modelName: a.modelName,
            promptVersion: a.promptVersion,
            sectionKey: a.sectionKey,
            entityLabel: a.entityLabel,
            reasonCode: a.reasonCode,
            upCount: a.upCount,
            downCount: a.downCount,
            clearedCount: a.clearedCount,
            commentCount: a.commentCount,
            correctionCount: a.correctionCount,
            reasonedCount: a.reasonedCount,
            computedAt,
          }),
        );
      await this.databaseService.baseClient.$transaction(async (tx: unknown) => {
        await this.rollupRepository.replaceDay(tenantId, day, rows, tx);
      });
    }
  }

  private lookbackDays(): number {
    const value = this.appSettings.getValueWithDefault<unknown>(FEEDBACK_ROLLUP_LOOKBACK_DAYS_KEY, DEFAULT_LOOKBACK_DAYS);
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LOOKBACK_DAYS ? value : DEFAULT_LOOKBACK_DAYS;
  }

  /** The tenant-scope extension and sys-event attribution need the tenant in CLS; a worker has none of its own. */
  private async runAsWorker(tenantId: string, work: () => Promise<void>): Promise<boolean> {
    let ok = true;
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId, kind: 'feedback-rollup' }));
      try {
        await work();
      } catch (error) {
        ok = false;
        this.logger.error({ message: 'Feedback rollup failed for a tenant', tenantId, error: errorClass(error) });
      }
    });
    return ok;
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval("return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])", 1, LOCK_KEY, 'held', LOCK_TTL_SECONDS);
      return reply === 'OK';
    } catch (error) {
      // The replace is idempotent, so an overlapping run is wasteful, not harmful.
      this.logger.warn({ message: 'Feedback rollup lock unavailable; running without it', error: errorClass(error) });
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(LOCK_KEY).catch(() => undefined);
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(JOB_NAME);
      }
    } catch {
      // No job registered.
    }
    this.activeCron = null;
  }
}

function errorClass(error: unknown): string {
  return (error as { name?: string })?.name ?? 'Error';
}
