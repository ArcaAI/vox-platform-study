import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CronJob } from 'cron';
import { uuidv7 } from 'uuidv7';
import { DnaWritingStyleReportRepository, DnaWritingStyleReportEntityMapper, JobQueue, ResourceStatusType } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';

const JOB_NAME = 'dna-regeneration';

const DEFAULTS = {
  enabled: false,
  cron: '0 0 1 * *',
  jobDelayMs: 5000,
} as const;

export interface DnaRegenerationConfig {
  enabled: boolean;
  cron: string;
  jobDelayMs: number;
}

export interface DnaRegenerationResult {
  totalDoctors: number;
  jobsQueued: number;
  errors: string[];
}

@Injectable()
export class DnaRegenerationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnaRegenerationScheduler.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dnaReportRepository: DnaWritingStyleReportRepository,
    @InjectQueue(JobQueue.GenerateDnaReport) private readonly dnaQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
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

  getConfig(): DnaRegenerationConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('dna-regen.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('dna-regen.cron', DEFAULTS.cron),
      jobDelayMs: this.appSettingsService.getValueWithDefault<number>('dna-regen.job-delay-ms', DEFAULTS.jobDelayMs),
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
        this.logger.log('DNA regeneration disabled via settings — stopping scheduler');
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
  async handleScheduledRegeneration(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('DNA re-generation is disabled — skipping tick');
      return;
    }

    this.logger.log('Starting scheduled DNA re-generation for all doctors');

    try {
      const result = await this.regenerateAllDoctors();
      this.logger.log({
        message: 'DNA re-generation completed',
        totalDoctors: result.totalDoctors,
        jobsQueued: result.jobsQueued,
        errors: result.errors.length,
      });
    } catch (error) {
      this.logger.error(`DNA re-generation failed: ${error}`);
    }
  }

  async regenerateAllDoctors(): Promise<DnaRegenerationResult> {
    const { jobDelayMs } = this.getConfig();

    const qb = this.dnaReportRepository.$();
    qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    qb.Where({ isLatest: true });
    const models = await qb.ToList();

    const mapper = DnaWritingStyleReportEntityMapper.getInstance();
    const reports = models.map((m) => mapper.toDomainEntity(m));

    const doctorTenantPairs = new Map<string, { doctorId: string; tenantId: string }>();
    for (const report of reports) {
      if (!doctorTenantPairs.has(report.doctorId)) {
        doctorTenantPairs.set(report.doctorId, {
          doctorId: report.doctorId,
          tenantId: report.tenantId,
        });
      }
    }

    const result: DnaRegenerationResult = {
      totalDoctors: doctorTenantPairs.size,
      jobsQueued: 0,
      errors: [],
    };

    let index = 0;
    for (const [, { doctorId, tenantId }] of doctorTenantPairs) {
      try {
        const jobId = uuidv7();
        await this.dnaQueue.add(
          JobQueue.GenerateDnaReport,
          {
            jobId,
            doctorId,
            tenantId,
            userId: 'system-scheduler',
            isRegeneration: true,
            // L5/F7 — the shared provenance field every DNA enqueue stamps (`isRegeneration` is
            // this scheduler's own flag and is read nowhere else). Without it a scheduled
            // rebuild was indistinguishable from one nobody asked for.
            origin: 'scheduler',
          },
          {
            jobId,
            delay: index * jobDelayMs,
          },
        );
        result.jobsQueued++;
        index++;
      } catch (error) {
        const msg = `Failed to queue re-generation for doctor ${doctorId}: ${error}`;
        this.logger.warn(msg);
        result.errors.push(msg);
      }
    }

    return result;
  }

  // ── Private helpers ──────────────────────────────────────────

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledRegeneration();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'DNA regeneration cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule DNA regeneration cron job',
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
