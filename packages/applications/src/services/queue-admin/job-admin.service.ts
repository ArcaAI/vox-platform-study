import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Job, JobType } from 'bullmq';
import type { JobSummary, JobDetail } from '@arcaai/domains';
import { JobDataRedactorService } from './job-data-redactor.service';

const ALL_STATUSES: JobType[] = ['waiting', 'active', 'completed', 'failed', 'delayed'];

/**
 * How many jobs a NAME-FILTERED list may scan from the head of the queue.
 *
 * BullMQ can range-scan a queue by status but has no name predicate, so a name
 * filter has to be applied in process. Paginating the underlying range FIRST and
 * filtering after would only ever search the requested page — the defect this
 * constant exists to avoid — so the filtered path scans from index 0 and pages
 * within the matches. The cap bounds what one admin request can cost; past it
 * the filter is necessarily incomplete.
 */
const JOB_NAME_SCAN_LIMIT = 1000;

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

    const statuses: JobType[] = options.status ? [options.status as JobType] : [...ALL_STATUSES];

    // `jobName` was accepted by the controller DTO and declared on
    // `ListJobsOptions`, but never read here — so the console's queue-detail
    // search box sent a name and got every job back.
    const needle = options.jobName?.trim().toLowerCase();
    if (needle) {
      const scanned = await this.collectJobs(queue, statuses, JOB_NAME_SCAN_LIMIT);
      const matched = scanned.filter(({ job }) => job?.name?.toLowerCase().includes(needle));
      const items: JobSummary[] = matched.slice(start, start + limit).map(({ job, status }) => this.toJobSummary(job, queueName, status));
      // The total describes the FILTERED set — reporting the queue-wide count
      // here would offer the pager pages that hold nothing.
      return { items, total: matched.length, page, limit };
    }

    if (statuses.length === 1) {
      const [status] = statuses;
      const [jobs, total] = await Promise.all([queue.getJobs([status], start, start + limit - 1, false), queue.getJobCountByTypes(status)]);
      return { items: jobs.map((job) => this.toJobSummary(job, queueName, status)), total, page, limit };
    }

    // BullMQ applies start/end to EACH state of a multi-state range and
    // concatenates them in state order, so one multi-state call fills page 0
    // with waiting/active jobs and pages past the rest — completed jobs never
    // showed on the unfiltered board. Read every state's head through the end
    // of this page, merge newest-first, then slice.
    const [merged, total] = await Promise.all([this.collectJobs(queue, statuses, start + limit), queue.getJobCountByTypes(...statuses)]);
    const items: JobSummary[] = merged.slice(start, start + limit).map(({ job, status }) => this.toJobSummary(job, queueName, status));

    return { items, total, page, limit };
  }

  /** The first `count` jobs of each state, tagged with that state, newest-first across states. */
  private async collectJobs(queue: Queue, statuses: JobType[], count: number): Promise<{ job: Job; status: JobType }[]> {
    const perStatus = await Promise.all(
      statuses.map(async (status) => (await queue.getJobs([status], 0, count - 1, false)).map((job) => ({ job, status }))),
    );
    const recency = (job: Job) => job.finishedOn ?? job.processedOn ?? job.timestamp ?? 0;
    return perStatus.flat().sort((a, b) => recency(b.job) - recency(a.job));
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

  private toJobSummary(job: Job, queueName: string, status = ''): JobSummary {
    return {
      id: job.id!,
      name: job.name,
      queueName,
      status,
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
