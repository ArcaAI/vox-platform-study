import { JobQueue, JobType } from '@arcaai/domains';
import { JobsOptions } from 'bullmq';

// TODO: Implement this

export interface AddJobProps<T> {
  queueName: JobQueue | string;
  jobType: JobType | string;
  data: T;
  options?: JobsOptions;
}

export interface IRedisService {
  addJob<T>(props: AddJobProps<T>): Promise<void>;
}

export const IRedisService = Symbol('IRedisService');
