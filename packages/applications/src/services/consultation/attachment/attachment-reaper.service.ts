import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationAttachmentEntity,
  ConsultationAttachmentRepository,
  ConsultationAttachmentStatus,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import { IBlobStorageService } from '../../baseServices/storage/IBlobStorageService';
import { CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS } from '../../settings-registry/descriptors/consultation-attachments-feedback.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';

export const ATTACHMENT_REAPER_JOB_NAME = 'consultation-attachment-reaper';
const REAP_CRON_KEY = 'consultation.attachments.reapCron';
const REAP_CRON_DEFAULT = CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS.find((d) => d.key === REAP_CRON_KEY)?.default as string;
const LOCK_KEY = 'consultation-attachment-reaper:lock';
/** Bounds a crashed holder only; the lock is released explicitly at the end of a run. */
const LOCK_TTL_SECONDS = 15 * 60;
/** One run reads at most this many batches (of the repository's batch size) before yielding to the next tick. */
const MAX_BATCHES_PER_RUN = 10;

export interface AttachmentReapResult {
  skipped?: 'locked';
  expired: number;
  objectDeleteFailures: number;
}

/** The error CLASS for a log line, never its message (a provider message can quote a key). */
const errorClass = (error: unknown): string => (error as { name?: string })?.name ?? 'Error';

/**
 * Expires upload intents nobody completed. INTENT → EXPIRED is a CONDITIONAL update, the same column
 * `complete` claims with INTENT → UPLOADED, so a late completion and the reaper can never both win;
 * only the winner here deletes the object a client may have PUT, best effort (a failed delete is
 * logged and the expiry stands — the row no longer references it).
 *
 * Self-scheduling from `consultation.attachments.reapCron`, re-synced on every settings refresh.
 * Replicas each schedule it; a Redis lock keeps one run at a time (without Redis, overlapping runs
 * are harmless — every step is conditional). Each row is handled in its own tenant's worker
 * context, so the tenant-scoped store gate and the sys-event attribution see that tenant.
 */
@Injectable()
export class AttachmentReaperService extends BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentReaperService.name);
  private activeCron: string | null = null;
  private job: CronJob | null = null;

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly settings: TenantSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly attachmentRepository: ConsultationAttachmentRepository,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationAttachment);
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
    const cron = this.cronExpression();
    if (cron === this.activeCron) return;
    this.stopJob();
    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledReap();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @nestjs/schedule pins its own `cron` major; the CronJob types differ only nominally.
      this.schedulerRegistry.addCronJob(ATTACHMENT_REAPER_JOB_NAME, job as any);
      job.start();
      this.job = job;
      this.activeCron = cron;
    } catch (error) {
      this.activeCron = null;
      this.logger.error({ message: 'Failed to schedule the attachment intent reaper', cron, error: errorClass(error) });
    }
  }

  async handleScheduledReap(): Promise<void> {
    try {
      const result = await this.reapExpired();
      if (result.expired > 0 || result.objectDeleteFailures > 0) this.logger.log({ message: 'Attachment intent reaper finished', ...result });
    } catch (error) {
      this.logger.error({ message: 'Attachment intent reaper failed', error: errorClass(error) });
    }
  }

  async reapExpired(now: Date = new Date()): Promise<AttachmentReapResult> {
    const result: AttachmentReapResult = { expired: 0, objectDeleteFailures: 0 };
    if (!(await this.acquireLock())) return { ...result, skipped: 'locked' };
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
        const rows = await this.attachmentRepository.findReapable(now);
        let progressed = false;
        for (const row of rows) {
          if (!(await this.attachmentRepository.expireIntent(row.id))) continue;
          progressed = true;
          result.expired += 1;
          if (!(await this.afterExpiry(row))) result.objectDeleteFailures += 1;
        }
        // Rows a concurrent `complete` claimed are not reapable any more; stop when nothing moved.
        if (!progressed) break;
      }
      return result;
    } finally {
      await this.releaseLock();
    }
  }

  /** Object delete + sys-event in the row's tenant context; `false` when the delete failed. */
  private async afterExpiry(row: ConsultationAttachmentEntity): Promise<boolean> {
    let deleted = true;
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', row.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: row.tenantId, kind: 'attachment-reaper' }));
      try {
        await this.blobStorage.deleteObject({ bucket: row.bucketName, key: row.objectKey });
      } catch (error) {
        deleted = false;
        this.logger.warn({
          message: 'Could not delete an expired attachment intent object',
          attachmentId: row.id,
          tenantId: row.tenantId,
          error: errorClass(error),
        });
      }
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: row.id,
        data: { consultationId: row.consultationId, status: ConsultationAttachmentStatus.EXPIRED, reason: 'intent-expired' },
      });
    });
    return deleted;
  }

  private cronExpression(): string {
    try {
      const value = this.settings.resolvePlatform<string>(REAP_CRON_KEY).value;
      if (typeof value === 'string' && value.trim()) return value;
    } catch (error) {
      this.logger.warn({ message: 'Attachment reaper cron unreadable; using its declared default', error: errorClass(error) });
    }
    return REAP_CRON_DEFAULT;
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval("return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])", 1, LOCK_KEY, 'held', LOCK_TTL_SECONDS);
      return reply === 'OK';
    } catch (error) {
      // Every step is conditional, so an overlapping run is wasteful, not harmful.
      this.logger.warn({ message: 'Attachment reaper lock unavailable; running without it', error: errorClass(error) });
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    // swallow-ok: the TTL bounds a lock that could not be released.
    await this.redis.del(LOCK_KEY).catch(() => undefined);
  }

  private stopJob(): void {
    this.job?.stop();
    this.job = null;
    try {
      if (this.schedulerRegistry.getCronJob(ATTACHMENT_REAPER_JOB_NAME)) this.schedulerRegistry.deleteCronJob(ATTACHMENT_REAPER_JOB_NAME);
    } catch {
      // swallow-ok: `getCronJob` throws when no job is registered — nothing to remove.
    }
    this.activeCron = null;
  }
}
