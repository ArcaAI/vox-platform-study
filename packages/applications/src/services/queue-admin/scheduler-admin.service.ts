import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { SchedulerInfo } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';

const DYNAMIC_SCHEDULER_SETTINGS: Record<
  string,
  { enabledKey: string; cronKey: string }
> = {
  'dna-regeneration': {
    enabledKey: 'dna-regen.enabled',
    cronKey: 'dna-regen.cron',
  },
};

@Injectable()
export class SchedulerAdminService {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(IAppSettingsService)
    private readonly appSettingsService: IAppSettingsService,
  ) {}

  listSchedulers(): SchedulerInfo[] {
    const result: SchedulerInfo[] = [];

    const cronJobs = this.schedulerRegistry.getCronJobs();
    for (const [name, job] of cronJobs) {
      const dynamic = DYNAMIC_SCHEDULER_SETTINGS[name];
      result.push({
        name,
        type: 'cron',
        source: dynamic ? 'dynamic' : 'static',
        cronExpression: this.extractCronExpression(job),
        intervalMs: null,
        running: job.isActive ?? false,
        lastExecution: job.lastDate()?.toISOString() ?? null,
        nextExecution: this.safeNextDate(job),
        timeZone: (job as any).cronTime?.zone ?? null,
        settingsKey: dynamic?.cronKey ?? null,
      });
    }

    const intervals = this.schedulerRegistry.getIntervals();
    for (const name of intervals) {
      result.push({
        name,
        type: 'interval',
        source: 'static',
        cronExpression: null,
        intervalMs: null,
        running: true,
        lastExecution: null,
        nextExecution: null,
        timeZone: null,
        settingsKey: null,
      });
    }

    const timeouts = this.schedulerRegistry.getTimeouts();
    for (const name of timeouts) {
      result.push({
        name,
        type: 'timeout',
        source: 'static',
        cronExpression: null,
        intervalMs: null,
        running: true,
        lastExecution: null,
        nextExecution: null,
        timeZone: null,
        settingsKey: null,
      });
    }

    return result;
  }

  pauseScheduler(schedulerName: string): void {
    try {
      const job = this.schedulerRegistry.getCronJob(schedulerName);
      if (!job.isActive) {
        throw new ConflictException(
          `Scheduler '${schedulerName}' is already paused`,
        );
      }
      job.stop();
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new NotFoundException(
        `Scheduler '${schedulerName}' not found`,
      );
    }
  }

  resumeScheduler(schedulerName: string): void {
    try {
      const job = this.schedulerRegistry.getCronJob(schedulerName);
      if (job.isActive) {
        throw new ConflictException(
          `Scheduler '${schedulerName}' is already running`,
        );
      }
      job.start();
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new NotFoundException(
        `Scheduler '${schedulerName}' not found`,
      );
    }
  }

  async updateSchedulerCron(
    schedulerName: string,
    cronExpression: string,
  ): Promise<SchedulerInfo> {
    const dynamic = DYNAMIC_SCHEDULER_SETTINGS[schedulerName];
    if (!dynamic) {
      throw new BadRequestException(
        `Scheduler '${schedulerName}' is static and cannot be modified at runtime`,
      );
    }

    this.validateCronExpression(cronExpression);

    const entity = this.appSettingsService.getFromCache(dynamic.cronKey);
    if (entity) {
      // The actual DB update is handled through the global settings service.
      // After cache refresh, the @OnEvent handler in the scheduler picks up
      // the new cron expression and reconfigures the CronJob.
    }

    await this.appSettingsService.refreshCache();

    return this.getScheduler(schedulerName);
  }

  async toggleScheduler(
    schedulerName: string,
    enabled: boolean,
  ): Promise<SchedulerInfo> {
    const dynamic = DYNAMIC_SCHEDULER_SETTINGS[schedulerName];
    if (!dynamic) {
      throw new BadRequestException(
        `Scheduler '${schedulerName}' is static and cannot be toggled`,
      );
    }

    await this.appSettingsService.refreshCache();

    return this.getScheduler(schedulerName);
  }

  private getScheduler(name: string): SchedulerInfo {
    const all = this.listSchedulers();
    const found = all.find((s) => s.name === name);
    if (!found) {
      throw new NotFoundException(`Scheduler '${name}' not found`);
    }
    return found;
  }

  private validateCronExpression(expression: string): void {
    try {
      // eslint-disable-next-line no-new
      new CronJob(expression, () => {});
    } catch {
      throw new BadRequestException(
        `Invalid cron expression: '${expression}'`,
      );
    }
  }

  private extractCronExpression(job: CronJob): string | null {
    try {
      return (job as any).cronTime?.source ?? null;
    } catch {
      return null;
    }
  }

  private safeNextDate(job: CronJob): string | null {
    try {
      const next = job.nextDate();
      return next?.toISO?.() ?? null;
    } catch {
      return null;
    }
  }
}
