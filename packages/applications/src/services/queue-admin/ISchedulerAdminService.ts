import type { SchedulerInfo } from '@arcaai/domains';

export interface ISchedulerAdminService {
  listSchedulers(): SchedulerInfo[];
  pauseScheduler(schedulerName: string): void;
  resumeScheduler(schedulerName: string): void;
  updateSchedulerCron(
    schedulerName: string,
    cronExpression: string,
  ): Promise<SchedulerInfo>;
  toggleScheduler(
    schedulerName: string,
    enabled: boolean,
  ): Promise<SchedulerInfo>;
}
export const ISchedulerAdminService = Symbol('ISchedulerAdminService');
