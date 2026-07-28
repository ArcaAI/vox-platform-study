import type { ListJobsParams } from './types';

export const queueKeys = {
  root: ['queues'] as const,
  list: () => [...queueKeys.root, 'list'] as const,
  detail: (queueName: string) => [...queueKeys.root, 'detail', queueName] as const,
  jobs: (queueName: string, params?: ListJobsParams) => [...queueKeys.root, 'jobs', queueName, params ?? {}] as const,
  job: (queueName: string, jobId: string) => [...queueKeys.root, 'job', queueName, jobId] as const,
  schedulers: () => [...queueKeys.root, 'schedulers'] as const,
};
