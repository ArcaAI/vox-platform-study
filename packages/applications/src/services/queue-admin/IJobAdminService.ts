import type { JobDetail } from '@arcaai/domains';
import type {
  ListJobsOptions,
  PaginatedJobResult,
  BulkActionResult,
} from './job-admin.service';

export interface IJobAdminService {
  listJobs(
    queueName: string,
    options: ListJobsOptions,
  ): Promise<PaginatedJobResult>;
  getJobDetail(queueName: string, jobId: string): Promise<JobDetail>;
  retryJob(queueName: string, jobId: string): Promise<void>;
  removeJob(queueName: string, jobId: string): Promise<void>;
  promoteJob(queueName: string, jobId: string): Promise<void>;
  bulkAction(
    queueName: string,
    action: 'retry' | 'remove',
    jobIds: string[],
  ): Promise<BulkActionResult>;
}
export const IJobAdminService = Symbol('IJobAdminService');
