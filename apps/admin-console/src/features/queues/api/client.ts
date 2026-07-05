/** BullMQ queue/job + scheduler operations (capabilities-matrix row 9). */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type {
    BulkJobActionRequest,
    BulkJobActionResult,
    CleanQueueRequest,
    CleanQueueResult,
    JobDetail,
    ListJobsParams,
    PaginatedJobs,
    QueueStats,
    SchedulerInfo,
} from './types';

const QUEUES = 'admin/queues';
const SCHEDULERS = 'admin/schedulers';

const queuePath = (queueName: string) => `${QUEUES}/${encodeURIComponent(queueName)}`;
const jobPath = (queueName: string, jobId: string) => `${queuePath(queueName)}/jobs/${encodeURIComponent(jobId)}`;

export function listQueues(): Promise<QueueStats[]> {
    return getJson(QUEUES);
}

export function getQueue(queueName: string): Promise<QueueStats> {
    return getJson(queuePath(queueName));
}

export function pauseQueue(queueName: string): Promise<{ success: boolean }> {
    return postJson(`${queuePath(queueName)}/pause`);
}

export function resumeQueue(queueName: string): Promise<{ success: boolean }> {
    return postJson(`${queuePath(queueName)}/resume`);
}

export function cleanQueue(queueName: string, body: CleanQueueRequest): Promise<CleanQueueResult> {
    return postJson(`${queuePath(queueName)}/clean`, body);
}

/** NOTE: custom envelope { items, total, page, limit }. */
export function listJobs(queueName: string, params?: ListJobsParams): Promise<PaginatedJobs> {
    return getJson(`${queuePath(queueName)}/jobs`, params);
}

export function getJob(queueName: string, jobId: string): Promise<JobDetail> {
    return getJson(jobPath(queueName, jobId));
}

export function retryJob(queueName: string, jobId: string): Promise<{ success: boolean }> {
    return postJson(`${jobPath(queueName, jobId)}/retry`);
}

export function promoteJob(queueName: string, jobId: string): Promise<{ success: boolean }> {
    return postJson(`${jobPath(queueName, jobId)}/promote`);
}

export function removeJob(queueName: string, jobId: string): Promise<{ success: boolean }> {
    return deleteJson(jobPath(queueName, jobId));
}

export function bulkJobAction(queueName: string, body: BulkJobActionRequest): Promise<BulkJobActionResult> {
    return postJson(`${queuePath(queueName)}/jobs/bulk`, body);
}

export function listSchedulers(): Promise<SchedulerInfo[]> {
    return getJson(SCHEDULERS);
}

export function pauseScheduler(name: string): Promise<{ success: boolean }> {
    return postJson(`${SCHEDULERS}/${encodeURIComponent(name)}/pause`);
}

export function resumeScheduler(name: string): Promise<{ success: boolean }> {
    return postJson(`${SCHEDULERS}/${encodeURIComponent(name)}/resume`);
}

export function updateSchedulerCron(name: string, cronExpression: string): Promise<SchedulerInfo> {
    return patchJson(`${SCHEDULERS}/${encodeURIComponent(name)}/cron`, { cronExpression });
}

export function toggleScheduler(name: string, enabled: boolean): Promise<SchedulerInfo> {
    return patchJson(`${SCHEDULERS}/${encodeURIComponent(name)}/toggle`, { enabled });
}
