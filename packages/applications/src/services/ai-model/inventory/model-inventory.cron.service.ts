import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { ModelInventoryService } from './model-inventory.service';

const JOB_NAME = 'model-registry-inventory';

/**
 * Code defaults for the scheduled inventory sweep — the LAST fallback of the
 * cascade, behind whatever `GlobalSetting` rows a platform admin has written.
 *
 * Both keys are now REGISTERED descriptors
 * (`settings-registry/descriptors/ai-readiness.descriptors.ts`), so the sweep's
 * posture is admin-reachable rather than a code constant; the earlier note here
 * ("until those descriptors are registered … the sweep runs on demand only") no
 * longer holds, and the two sides are pinned together by
 * `__tests__/ai-readiness.descriptors.test.ts`.
 *
 * `enabled` ships ON. It is NOT a kill-switch (which the registry requires to
 * default OFF): turning it off removes a MEASUREMENT, not an enforcement path —
 * the same polarity as `metering.outbox.drain.enabled`. And the measurement is
 * load-bearing: `AiModel.availability`, which this sweep is the only scheduled
 * writer of, is half of the readiness verdict for every platform-served model
 * (TASK-890 §3.12), so leaving it off reports `unknown` forever on a platform
 * that is in fact serving. The on-demand route (`POST admin/ai-models/inventory`)
 * and the publish processor's own row stamp are unchanged.
 */
const DEFAULTS = {
  enabled: true,
  cron: '0 * * * *',
} as const;

export const MODEL_INVENTORY_SETTING_KEYS = {
  enabled: 'modelRegistry.inventory.enabled',
  cron: 'modelRegistry.inventory.cron',
} as const;

export interface ModelInventoryCronConfig {
  enabled: boolean;
  cron: string;
}

/**
 * Settings-gated hourly sweep over {@link ModelInventoryService.runInventory}.
 * Scheduling mirrors `PipelineTemplateResyncCronService`: self-registering
 * through `SchedulerRegistry`, reading its config from `IAppSettingsService`,
 * re-syncing on every settings-cache refresh so an operator's toggle takes
 * effect without a restart. Runs with no CLS context (the inventory writes
 * through the base client).
 */
@Injectable()
export class ModelInventoryCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModelInventoryCronService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly inventory: ModelInventoryService,
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

  getConfig(): ModelInventoryCronConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>(MODEL_INVENTORY_SETTING_KEYS.enabled, DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>(MODEL_INVENTORY_SETTING_KEYS.cron, DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Model inventory disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  async handleScheduledInventory(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Model inventory is disabled — skipping tick');
      return;
    }
    try {
      await this.inventory.runInventory();
    } catch (error) {
      // A bucket outage must not crash the scheduler; the next tick retries.
      this.logger.error({ message: 'Scheduled model inventory failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledInventory();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob generic does not unify with the `cron` package's
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Model inventory cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule model inventory cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(JOB_NAME);
      existing.stop();
      this.schedulerRegistry.deleteCronJob(JOB_NAME);
    } catch {
      // Not registered — nothing to stop.
    }
    this.activeCron = null;
  }
}
