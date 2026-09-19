import { ResourceType, SysEventType, TranscriptionJobEntity, TranscriptionJobRepository, TranscriptionJobStatus } from '@arcaai/domains';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';

import { BaseService, createWorkerSession } from '../../../../common';
import { IActiveUserContext } from '../../../../interfaces';
import { IAppSettingsService } from '../../../baseServices/_meta/appSettings/IAppSettingsService';
import {
  STT_BATCH_REAPER_CRON_KEY,
  STT_BATCH_STALE_PROCESSING_MINUTES_KEY,
  STT_GATEWAY_DEFAULTS,
} from '../../../settings-registry/descriptors/stt-gateway.descriptors';

const JOB_NAME = 'stt-batch-job-reaper';
const MS_PER_MINUTE = 60_000;

/**
 * The `errorCode` a reaped job carries.
 *
 * Deliberately its own code rather than a generic failure: "the worker holding
 * this job disappeared" is an infrastructure event, and conflating it with a
 * transcription that genuinely failed would hide a class of incident inside
 * ordinary error-rate noise.
 */
export const STT_JOB_REAPER_ERROR_CODE = 'WORKER_LOST';

export interface SttJobReaperConfig {
  cron: string;
  staleProcessingMinutes: number;
}

export interface SttJobReaperResult {
  eligible: number;
  reaped: number;
  failed: number;
}

/**
 * TASK-992 — the stranded-batch-job sweep.
 *
 * ## What it is for
 *
 * `SttInternalService.startJob` recovers a job whose worker died **as long as
 * the broker redelivers the message**: the new worker's claim reclaims the row
 * and the job runs to a terminal state. That covers the observed incident, and
 * it covers nothing when the message itself is gone — a broker flush, a queue
 * purge, a message whose redelivery was itself ACKed by an older worker build.
 * Then no one ever calls `/start` again and the row sits in PROCESSING with
 * `completedAt` NULL until someone notices by hand. Two rows were in exactly
 * that state on `hope-v2-dev` when this ticket was written, one of them since
 * February. Nothing in the platform could end either.
 *
 * ## Why `updatedAt` is the signal
 *
 * The worker's progress callbacks land through `repository.update`, so
 * `updatedAt` is the closest thing a job row has to a heartbeat. `startedAt`
 * only records when the current attempt began, so it would reap a long,
 * healthy transcription. A job still emitting progress is therefore never
 * eligible, however long it has been running.
 *
 * ## Why the window must stay above the worker's own time limit
 *
 * Dramatiq kills the attempt's thread at `transcription_timeout_seconds`
 * (600 s). Keeping `stt.batch.staleProcessingMinutes` above that means the
 * reaper can only ever touch a job with nothing left alive to interrupt —
 * which matters because diarization emits no progress at all, so a live worker
 * can legitimately be silent for minutes. The default is 2x that limit.
 *
 * ## Shape
 *
 * Self-scheduling, mirroring {@link ConsultationTimeoutSweepService}: a
 * `SchedulerRegistry` cron job re-synced whenever the `GlobalSetting` cache
 * refreshes (`@OnEvent('app-settings.cache-refreshed')`), so both the cadence
 * and the window are tunable live. No `enabled` kill-switch — this performs the
 * same status transition the worker itself would have performed had it lived,
 * on the platform's behalf when nobody is left to do it.
 *
 * The eligibility QUERY runs cross-tenant with no CLS context (a platform-wide
 * maintenance tick — the tenant-scope Prisma extension passes through when no
 * CLS tenant is set). Each row's WRITE is wrapped in its own `clsService.run()`
 * bound to that row's `tenantId`, because `broadcastSysEvent` sources the
 * tenant exclusively from CLS.
 */
@Injectable()
export class SttJobReaperService extends BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SttJobReaperService.name);
  private activeCron: string | null = null;

  constructor(
    private readonly jobRepository: TranscriptionJobRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  /** Re-reads config on each `AppSettingsService` cache refresh (~45 s). */
  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  getConfig(): SttJobReaperConfig {
    return {
      cron: this.appSettingsService.getValueWithDefault<string>(STT_BATCH_REAPER_CRON_KEY, STT_GATEWAY_DEFAULTS[STT_BATCH_REAPER_CRON_KEY]),
      staleProcessingMinutes: this.appSettingsService.getValueWithDefault<number>(
        STT_BATCH_STALE_PROCESSING_MINUTES_KEY,
        STT_GATEWAY_DEFAULTS[STT_BATCH_STALE_PROCESSING_MINUTES_KEY],
      ),
    };
  }

  syncSchedulerFromConfig(): void {
    const { cron } = this.getConfig();
    if (cron === this.activeCron) {
      return;
    }
    this.replaceJob(cron);
  }

  async handleScheduledSweep(): Promise<void> {
    try {
      const result = await this.sweepOnce();
      if (result.eligible > 0) {
        this.logger.warn({ message: 'Stranded STT batch jobs reaped', ...result });
      }
    } catch (error) {
      this.logger.error(`Stranded-job sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One pass: fail every PROCESSING job whose row has not been written to
   * within the configured window. A single row's failure — most plausibly a
   * race in which it reached a terminal state between the read and the write —
   * is logged and skipped; it never aborts the batch.
   */
  async sweepOnce(): Promise<SttJobReaperResult> {
    const { staleProcessingMinutes } = this.getConfig();

    // A non-positive window would place the cutoff at or after "now" and reap
    // every in-flight job on the platform in a single tick, including ones
    // that started a second ago. Mirrors the same guard in
    // `ConsultationTimeoutSweepService.sweepOnce`.
    if (staleProcessingMinutes < 1) {
      this.logger.warn({ message: 'STT stranded-job window is non-positive — refusing to sweep', staleProcessingMinutes });
      return { eligible: 0, reaped: 0, failed: 0 };
    }

    const cutoff = new Date(Date.now() - staleProcessingMinutes * MS_PER_MINUTE);
    const eligible = await this.jobRepository.findStaleProcessingJobs(cutoff);

    let reaped = 0;
    let failed = 0;

    for (const job of eligible) {
      try {
        await this.reapOne(job, staleProcessingMinutes);
        reaped++;
      } catch (error) {
        failed++;
        this.logger.warn({
          message: 'Stranded-job sweep: failed to fail a job (non-fatal — the sweep continues with the next row)',
          jobId: job.id,
          tenantId: job.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { eligible: eligible.length, reaped, failed };
  }

  /**
   * Fails one row, attributed to ITS OWN tenant.
   *
   * The error message names the worker that vanished, because the row's
   * `workerId` is overwritten by any later reclaim and this is the only place
   * that identity is preserved for whoever reads the failure afterwards.
   */
  private async reapOne(job: TranscriptionJobEntity, staleProcessingMinutes: number): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', job.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: job.tenantId, kind: 'stt-job-reaper' }));

      job.fail(
        `Worker ${job.workerId ?? 'unknown'} stopped reporting progress for more than ${staleProcessingMinutes} minutes; the job was never redelivered.`,
        STT_JOB_REAPER_ERROR_CODE,
      );

      await this.jobRepository.update(job.id, job);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: job.id,
        responsibleEntityId: job.createdBy || undefined,
        data: { status: TranscriptionJobStatus.FAILED, errorCode: STT_JOB_REAPER_ERROR_CODE, workerId: job.workerId ?? undefined },
      });
    });
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledSweep();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob generic doesn't line up with the `cron` package's own CronJob type; mirrors the identical cast in ConsultationTimeoutSweepService
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'STT stranded-job reaper scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule the STT stranded-job reaper',
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
