import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { AgentTrajectoryService } from '../agent-trajectory/agent-trajectory.service';

const JOB_NAME = 'agent-trajectory-retention';

/**
 * defaults for the AgentTrajectoryStep retention prune.
 *
 * `enabled` is OFF by default: retention HARD-DELETES telemetry rows, so an
 * operator must explicitly opt in before any data is removed. Window default
 * is 30 days (`agentic.trajectory.retentionDays`); cron defaults to 04:00 UTC.
 */
const DEFAULTS = {
  enabled: false,
  cron: '0 4 * * *',
  retentionDays: 30,
} as const;

export interface AgentTrajectoryRetentionConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
}

/**
 * nightly prune of aged `AgentTrajectoryStep` rows.
 *
 * Mirrors {@link AuditRetentionService}: self-scheduling via SchedulerRegistry
 * + AppSettings (`@OnEvent('app-settings.cache-refreshed')`). Delegates the
 * hard delete to {@link AgentTrajectoryService.pruneOlderThan} (repository
 * path only — no Prisma client in this service).
 *
 * AppSettings keys:
 *   - `agentic.trajectory.enabled` (default false)
 *   - `agentic.trajectory.cron` (default `0 4 * * *`)
 *   - `agentic.trajectory.retentionDays` (default 30)
 */
@Injectable()
export class AgentTrajectoryRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTrajectoryRetentionService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly agentTrajectoryService: AgentTrajectoryService,
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

  getConfig(): AgentTrajectoryRetentionConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('agentic.trajectory.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('agentic.trajectory.cron', DEFAULTS.cron),
      retentionDays: this.appSettingsService.getValueWithDefault<number>('agentic.trajectory.retentionDays', DEFAULTS.retentionDays),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Agent-trajectory retention disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  async handleScheduledPurge(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Agent-trajectory retention is disabled — skipping tick');
      return;
    }

    const { retentionDays } = this.getConfig();
    if (retentionDays < 1) {
      this.logger.warn({
        message: 'Agent-trajectory retention window is non-positive — refusing to purge',
        retentionDays,
      });
      return;
    }

    this.logger.log('Starting scheduled agent-trajectory retention prune');

    try {
      const totalDeleted = await this.agentTrajectoryService.pruneOlderThan(retentionDays);
      this.logger.log({
        message: 'Agent-trajectory retention prune completed',
        retentionDays,
        totalDeleted,
      });
    } catch (error) {
      this.logger.error(`Agent-trajectory retention prune failed: ${error}`);
    }
  }

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

      this.logger.log({ message: 'Agent-trajectory retention cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule agent-trajectory retention cron job',
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
