export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

/** GET /admin/queues rows (QueueStatsResponse). */
export interface QueueStats {
    name: string;
    isPaused: boolean;
    counts: {
        waiting: number;
        active: number;
        completed: number;
        failed: number;
        delayed: number;
        paused: number;
        prioritized: number;
    };
    workerCount: number;
}

export interface ListJobsParams {
    /** Zero-based page. */
    page?: number;
    /** 1..100. */
    limit?: number;
    status?: JobStatus;
    jobName?: string;
    [key: string]: string | number | boolean | undefined | null;
}

/** GET :queueName/jobs envelope — CUSTOM: `items`, not `data`. */
export interface PaginatedJobs {
    items: JobSummary[];
    total: number;
    page: number;
    limit: number;
}

export interface JobSummary {
    id: string;
    name: string;
    queueName: string;
    status: string;
    progress: number | null;
    attempts: number;
    maxAttempts: number;
    delay: number;
    timestamp: number;
    processedOn: number | null;
    finishedOn: number | null;
    failedReason: string | null;
    parentId: string | null;
}

export interface JobDetail extends JobSummary {
    data: Record<string, unknown>;
    returnValue: unknown;
    stacktrace: string[];
    logs: string[];
    opts: {
        attempts: number;
        delay: number;
        backoff: { type: string; delay: number } | null;
        priority: number;
        removeOnComplete: boolean | number;
        removeOnFail: boolean | number;
    };
}

export interface CleanQueueRequest {
    status: 'completed' | 'failed';
    gracePeriodMs: number;
    limit?: number;
}

export interface CleanQueueResult {
    removedJobIds: string[];
    count: number;
}

export interface BulkJobActionRequest {
    action: 'retry' | 'remove';
    /** 1..100 ids. */
    jobIds: string[];
}

export interface BulkJobActionResult {
    succeeded: number;
    failed: number;
}

/** GET /admin/schedulers rows (SchedulerInfoResponse). */
export interface SchedulerInfo {
    name: string;
    type: 'cron' | 'interval' | 'timeout';
    source: 'static' | 'dynamic';
    cronExpression: string | null;
    intervalMs: number | null;
    running: boolean;
    lastExecution: string | null;
    nextExecution: string | null;
    timeZone: string | null;
    settingsKey: string | null;
}
