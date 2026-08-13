import { TenantRepository } from '@arcaai/domains';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { AgentTemplateResyncService, AgentTemplateResyncSummary } from './agent-template-resync.service';

const JOB_NAME = 'agent-template-resync';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * FAIL-SAFE defaults for the nightly SYSTEM agent-library resync sweep.
 *
 * `enabled` is OFF here on purpose, and it must stay that way: the registry
 * descriptor (`departmentAgent.templateResync.enabled`) is a KILL-SWITCH, and
 * `SettingsRegistry.killSwitches()` throws at assembly if any kill-switch
 * defaults ON. These constants are the fallback for an UNCONFIGURED system.
 *
 * The sweep is turned ON by a platform VALUE instead: a locked SYSTEM-tenant
 * `GlobalSetting` row seeded in `11-global-setting.ts` (`value: 'true'`,
 * `defaultValue: 'false'`), mirroring the pipeline resync sweep.
 */
const DEFAULTS = {
  enabled: false,
  // One hour after the pipeline sweep (03:00) so the two nightly reconcilers
  // don't contend for the DB at the same minute.
  cron: '0 4 * * *',
} as const;

export interface AgentTemplateResyncCronConfig {
  enabled: boolean;
  cron: string;
}

/**
 * Settings-gated nightly sweep that runs
 * {@link AgentTemplateResyncService.resyncTenant} across every non-SYSTEM
 * tenant. The SIBLING of `PipelineTemplateResyncCronService`.
 *
 * Self-registers through `SchedulerRegistry`, reads its config from
 * `IAppSettingsService`, and re-syncs whenever the settings cache refreshes so
 * an operator's toggle takes effect without a restart.
 *
 * AppSettings keys (both registered in `platform-ops.descriptors.ts`):
 *   - `departmentAgent.templateResync.enabled` — fail-safe default false; SEEDED TRUE
 *   - `departmentAgent.templateResync.cron`    — default `0 4 * * *`
 *
 * The sweep runs with no CLS context, which the tenant-context provider treats
 * as elevated/tenant-less — exactly the pass-through the reconciler needs to
 * read the SYSTEM library and write into each target tenant.
 */
@Injectable()
export class AgentTemplateResyncCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTemplateResyncCronService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly resyncService: AgentTemplateResyncService,
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

  getConfig(): AgentTemplateResyncCronConfig {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>('departmentAgent.templateResync.enabled', DEFAULTS.enabled),
      cron: this.appSettingsService.getValueWithDefault<string>('departmentAgent.templateResync.cron', DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Agent template resync disabled via settings — stopping scheduler');
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
   * Run the reconciler across every non-SYSTEM tenant, returning aggregated
   * totals. Shared by the scheduled tick AND the admin trigger endpoint.
   */
  async resyncAllTenants(): Promise<AgentTemplateResyncSummary> {
    // The SYSTEM tenant owns the golden library; it is never a resync target.
    const allTenants = await this.tenantRepository.findAll({});
    const targets = allTenants.filter((tenant) => tenant.id !== SYSTEM_TENANT_ID);

    this.logger.log({ message: 'Starting agent template resync sweep', tenantCount: targets.length });

    const totals: AgentTemplateResyncSummary = { added: 0, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 0 };

    for (const tenant of targets) {
      try {
        const summary = await this.resyncService.resyncTenant(tenant.id);
        totals.added += summary.added;
        totals.fastForwarded += summary.fastForwarded;
        totals.skipped += summary.skipped;
        totals.configPropagated += summary.configPropagated;
        totals.configBlocked += summary.configBlocked;
      } catch (error) {
        // Per-tenant isolation: one failing tenant must not stop the sweep.
        this.logger.error({
          message: 'Agent template resync failed for tenant - continuing',
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({ message: 'Agent template resync sweep completed', ...totals });
    return totals;
  }

  async handleScheduledResync(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Agent template resync is disabled — skipping tick');
      return;
    }
    await this.resyncAllTenants();
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

      this.logger.log({ message: 'Agent template resync cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule agent template resync cron job',
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
