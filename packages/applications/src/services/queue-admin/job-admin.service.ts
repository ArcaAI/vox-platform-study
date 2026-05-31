import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Job, JobType } from 'bullmq';
import type { JobSummary, JobDetail } from '@arcaai/domains';
import { JobDataRedactorService } from './job-data-redactor.service';

const ALL_STATUSES: JobType[] = ['waiting', 'active', 'completed', 'failed', 'delayed'];

export interface ListJobsOptions {
  page?: number;
  limit?: number;
  status?: string;
  jobName?: string;
}

export interface PaginatedJobResult {
  items: JobSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface BulkActionResult {
  succeeded: number;
  failed: number;
}

@Injectable()
export class JobAdminService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly redactorService: JobDataRedactorService,
  ) {}

  async listJobs(queueName: string, options: ListJobsOptions): Promise<PaginatedJobResult> {
    const queue = this.getQueue(queueName);
    const page = options.page ?? 0;
    const limit = options.limit ?? 20;
    const start = page * limit;
    const end = start + limit - 1;

    const statuses: JobType[] = options.status ? [options.status as JobType] : [...ALL_STATUSES];

    const [jobs, total] = await Promise.all([queue.getJobs(statuses, start, end, true), queue.getJobCountByTypes(...statuses)]);

    const items: JobSummary[] = jobs.map((job) => this.toJobSummary(job, queueName));

    return { items, total, page, limit };
  }

  async getJobDetail(queueName: string, jobId: string): Promise<JobDetail> {
    const job = await this.getJobOrThrow(queueName, jobId);
    const state = await job.getState();

    const redactedData = this.redactorService.redact((job.data ?? {}) as Record<string, unknown>, queueName, 'detail');

    return {
      ...this.toJobSummary(job, queueName),
      status: state,
      data: redactedData,
      returnValue: job.returnvalue ?? null,
      stacktrace: job.stacktrace ?? [],
      logs: [],
      opts: {
        attempts: job.opts.attempts ?? 1,
        delay: job.opts.delay ?? 0,
        backoff: job.opts.backoff
          ? {
              type: typeof job.opts.backoff === 'object' ? job.opts.backoff.type : 'fixed',
              delay: typeof job.opts.backoff === 'object' ? job.opts.backoff.delay : 0,
            }
          : null,
        priority: job.opts.priority ?? 0,
        removeOnComplete: this.normalizeKeepJobs(job.opts.removeOnComplete),
        removeOnFail: this.normalizeKeepJobs(job.opts.removeOnFail),
      },
    };
  }

  async retryJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getJobOrThrow(queueName, jobId);
    await job.retry();
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getJobOrThrow(queueName, jobId);
    await job.remove();
  }

  async promoteJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getJobOrThrow(queueName, jobId);
    await job.promote();
  }

  async bulkAction(queueName: string, action: 'retry' | 'remove', jobIds: string[]): Promise<BulkActionResult> {
    const queue = this.getQueue(queueName);
    let succeeded = 0;
    let failed = 0;

    for (const jobId of jobIds) {
      try {
        const job = await queue.getJob(jobId);
        if (!job) {
          failed++;
          continue;
        }

        if (action === 'retry') {
          await job.retry();
        } else {
          await job.remove();
        }
        succeeded++;
      } catch {
        failed++;
      }
    }

    return { succeeded, failed };
  }

  private toJobSummary(job: Job, queueName: string): JobSummary {
    return {
      id: job.id!,
      name: job.name,
      queueName,
      status: '',
      progress: typeof job.progress === 'number' ? job.progress : null,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      delay: job.opts.delay ?? 0,
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason ?? null,
      parentId: job.parentKey ?? null,
    };
  }

  private normalizeKeepJobs(value: unknown): boolean | number {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && value !== null && 'count' in value) {
      return (value as { count: number }).count;
    }
    return false;
  }

  private async getJobOrThrow(queueName: string, jobId: string): Promise<Job> {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Job '${jobId}' not found in queue '${queueName}'`);
    }
    return job;
  }

  private getQueue(queueName: string): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queueName), {
      strict: false,
    });
  }
}
