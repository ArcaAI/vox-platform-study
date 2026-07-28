import { TenantRepository } from '@arcaai/domains';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { PipelineTemplateResyncService } from './pipeline-template-resync.service';

const JOB_NAME = 'pipeline-template-resync';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * FAIL-SAFE defaults for the nightly SYSTEM-template resync sweep.
 *
 * `enabled` is OFF here on purpose, and it must stay that way: the registry
 * descriptor (`pipeline.templateResync.enabled`) is a KILL-SWITCH, and
 * `SettingsRegistry.killSwitches()` throws at assembly if any kill-switch
 * defaults ON. These constants are the fallback for an UNCONFIGURED system —
 * they are not the deployed posture.
 *
 * The sweep is turned ON by a platform VALUE instead: a locked SYSTEM-tenant
 * `GlobalSetting` row seeded in `11-global-setting.ts` (`value: 'true'`,
 * `defaultValue: 'false'`, so a reset reverts to fail-safe). That keeps the
 * governance invariant intact while shipping the sweep enabled, and leaves a
 * GLOBAL_ADMIN able to flip it from the settings surface at any time.
 */
const DEFAULTS = {
  enabled: false,
  cron: '0 3 * * *',
} as const;

export interface PipelineTemplateResyncCronConfig {
  enabled: boolean;
  cron: string;
}

/**
 * Settings-gated nightly sweep that runs
 * {@link PipelineTemplateResyncService.resyncTenant} across every non-SYSTEM
 * tenant.
 *
 * Scheduling mirrors {@link AgentTrajectoryRetentionService}: self-registering
 * through `SchedulerRegistry`, reading its config from `IAppSettingsService`,
 * and re-syncing whenever the settings cache refreshes so an operator's toggle
 * takes effect without a restart.
 *
 * AppSettings keys (both registered in `platform-ops.descriptors.ts`, so they
 * appear on the admin settings surface and are writable through the registry):
 *   - `pipeline.templateResync.enabled` — fail-safe default false; SEEDED TRUE
 *   - `pipeline.templateResync.cron`    — default `0 3 * * *`
 *
 * The sweep runs with no CLS context, which the tenant-context provider treats
 * as elevated/tenant-less — exactly the pass-through the reconciler needs to
 * write into each target tenant (see the service's TENANT CONTEXT note).
 */
@Injectable()
export class PipelineTemplateResyncCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineTemplateResyncCronService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly resyncService: PipelineTemplateResyncService,
    private readonly tenantRepository: TenantRepository,
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

  getConfig(): PipelineTemplateResyncCronConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('pipeline.templateResync.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('pipeline.templateResync.cron', DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Pipeline template resync disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  async handleScheduledResync(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Pipeline template resync is disabled — skipping tick');
      return;
    }

    // The SYSTEM tenant owns the templates; it is never a resync target.
    const allTenants = await this.tenantRepository.findAll({});
    const targets = allTenants.filter((tenant) => tenant.id !== SYSTEM_TENANT_ID);

    this.logger.log({ message: 'Starting scheduled pipeline template resync', tenantCount: targets.length });

    const totals = { added: 0, fastForwarded: 0, skipped: 0 };

    for (const tenant of targets) {
      try {
        const summary = await this.resyncService.resyncTenant(tenant.id);
        totals.added += summary.added;
        totals.fastForwarded += summary.fastForwarded;
        totals.skipped += summary.skipped;
      } catch (error) {
        // Per-tenant isolation: one failing tenant must not stop the sweep.
        this.logger.error({
          message: 'Pipeline template resync failed for tenant - continuing',
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({ message: 'Scheduled pipeline template resync completed', ...totals });
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledResync();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Pipeline template resync cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule pipeline template resync cron job',
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
