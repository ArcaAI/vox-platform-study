import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — mirror the backend queue-admin surface (TASK-250 / OB-03):
//   - GET    /admin/queues                          → QueueStats[]
//   - GET    /admin/queues/:queueName               → QueueStats
//   - POST   /admin/queues/:queueName/pause|resume  → { success }
//   - POST   /admin/queues/:queueName/clean         → { removedJobIds, count }
//   - GET    /admin/queues/:queueName/jobs          → PaginatedJobs ({ items })
//   - GET    /admin/queues/:queueName/jobs/:jobId   → JobDetail (PII-redacted)
//   - POST   /admin/queues/:queueName/jobs/bulk     → { succeeded, failed }
//   - POST   /admin/queues/:queueName/jobs/:jobId/retry|promote → { success }
//   - DELETE /admin/queues/:queueName/jobs/:jobId   → { success }
//
// OB-03: GLOBAL_ADMIN-only controller (`@Authorize(['manage','all'])`). This
// client only consumes the existing API — no backend changes.
//
// IMPORTANT — the job-list `page` is ZERO-BASED (BullMQ semantics), distinct
// from the 1-based admin consultation list. The screen passes the table's
// 0-based `pageIndex` straight through.
// ---------------------------------------------------------------------------

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  prioritized: number;
}

export interface QueueStats {
  name: string;
  isPaused: boolean;
  counts: QueueJobCounts;
  workerCount: number;
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

export interface JobOptions {
  attempts: number;
  delay: number;
  backoff: { type: string; delay: number } | null;
  priority: number;
  removeOnComplete: boolean | number;
  removeOnFail: boolean | number;
}

export interface JobDetail extends JobSummary {
  data: Record<string, unknown>;
  returnValue: unknown | null;
  stacktrace: string[];
  logs: string[];
  opts: JobOptions;
}

export interface PaginatedJobs {
  items: JobSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface CleanQueueResult {
  removedJobIds: string[];
  count: number;
}

export interface BulkActionResult {
  succeeded: number;
  failed: number;
}

/** Statuses that can be filtered in the job list (BullMQ `JobType`s). */
export const JOB_STATUS_FILTERS = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];

/** Only finished jobs are cleanable. */
export const CLEANABLE_STATUSES = ['completed', 'failed'] as const;
export type CleanableStatus = (typeof CLEANABLE_STATUSES)[number];

/** The backend bulk endpoint only supports retry/remove. */
export const BULK_ACTIONS = ['retry', 'remove'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export interface ListJobsParams {
  page?: number;
  limit?: number;
  status?: JobStatusFilter;
  jobName?: string;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const queueKeys = {
  all: ['admin', 'queues'] as const,
  list: () => [...queueKeys.all, 'list'] as const,
  detail: (queueName: string) => [...queueKeys.all, 'detail', queueName] as const,
  jobs: (queueName: string, params?: ListJobsParams) => [...queueKeys.all, queueName, 'jobs', params] as const,
  job: (queueName: string, jobId: string) => [...queueKeys.all, queueName, 'job', jobId] as const,
};

function qs(params?: object): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useQueues(options?: Omit<UseQueryOptions<QueueStats[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queueKeys.list(),
    queryFn: () => adminClient.get<QueueStats[]>('/admin/queues'),
    ...options,
  });
}

export function useQueueJobs(queueName: string, params?: ListJobsParams, options?: Omit<UseQueryOptions<PaginatedJobs>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queueKeys.jobs(queueName, params),
    queryFn: () => adminClient.get<PaginatedJobs>(`/admin/queues/${queueName}/jobs${qs(params)}`),
    enabled: !!queueName,
    ...options,
  });
}

export function useQueueJob(queueName: string, jobId: string, options?: Omit<UseQueryOptions<JobDetail>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queueKeys.job(queueName, jobId),
    queryFn: () => adminClient.get<JobDetail>(`/admin/queues/${queueName}/jobs/${jobId}`),
    enabled: !!queueName && !!jobId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks — every action mutates live BullMQ state and returns only an
// acknowledgement, so we invalidate the whole queue tree to refetch counts +
// the active jobs page.
// ---------------------------------------------------------------------------

interface JobRef {
  queueName: string;
  jobId: string;
}

export interface CleanQueueInput {
  queueName: string;
  status: CleanableStatus;
  gracePeriodMs: number;
  limit?: number;
}

export interface BulkJobActionInput {
  queueName: string;
  action: BulkAction;
  jobIds: string[];
}

export function usePauseQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (queueName: string) => adminClient.post<{ success: boolean }>(`/admin/queues/${queueName}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function useResumeQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (queueName: string) => adminClient.post<{ success: boolean }>(`/admin/queues/${queueName}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function useCleanQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queueName, status, gracePeriodMs, limit }: CleanQueueInput) =>
      adminClient.post<CleanQueueResult>(`/admin/queues/${queueName}/clean`, { status, gracePeriodMs, limit }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queueName, jobId }: JobRef) => adminClient.post<{ success: boolean }>(`/admin/queues/${queueName}/jobs/${jobId}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function usePromoteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queueName, jobId }: JobRef) => adminClient.post<{ success: boolean }>(`/admin/queues/${queueName}/jobs/${jobId}/promote`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function useRemoveJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queueName, jobId }: JobRef) => adminClient.delete<{ success: boolean }>(`/admin/queues/${queueName}/jobs/${jobId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}

export function useBulkJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queueName, action, jobIds }: BulkJobActionInput) =>
      adminClient.post<BulkActionResult>(`/admin/queues/${queueName}/jobs/bulk`, { action, jobIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queueKeys.all }),
  });
}
