/**
 * @arcaai/vox - useQueueAdmin Hook
 *
 * Global-admin BullMQ introspection over the queue-admin surface
 * (`/admin/queues`, `manage all` only).
 *
 * Deliberately NON-destructive: only read operations plus retry (single/bulk)
 * are exposed. Clean/remove/pause exist server-side but are intentionally
 * absent here so the admin console cannot invoke them.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendFilters } from '../utils/urlUtils';
import { QUEUE_ADMIN_ENDPOINTS } from '../core/constants';
import type { BulkJobActionResult, JobDetail, ListJobsParams, PaginatedJobs, QueueStats, RedisHealth } from '../types/ops-admin';

export interface UseQueueAdminReturn {
  /** Stats for every registered queue. Empty until first refresh. */
  queues: QueueStats[];
  /** Redis connection health snapshot. Null until first refresh. */
  redisHealth: RedisHealth | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<QueueStats[]>;
  refreshRedisHealth: () => Promise<RedisHealth>;
  /** List jobs in a queue (zero-based page, optional status/jobName filter). Not cached in state — callers own pagination. */
  listJobs: (queueName: string, params?: ListJobsParams) => Promise<PaginatedJobs>;
  /** Job detail (PII-redacted payload, stacktrace, options). */
  getJob: (queueName: string, jobId: string) => Promise<JobDetail>;
  /** Retry ONE failed job (re-uses the original payload). */
  retryJob: (queueName: string, jobId: string) => Promise<void>;
  /** Retry a set of failed jobs. The SDK exposes retry only — never remove. */
  bulkRetry: (queueName: string, jobIds: string[]) => Promise<BulkJobActionResult>;
}

export function useQueueAdmin(): UseQueueAdminReturn {
  const { execute, isLoading, error } = useApiOperation('useQueueAdmin');
  const [queues, setQueues] = useState<QueueStats[]>([]);
  const [redisHealth, setRedisHealth] = useState<RedisHealth | null>(null);

  const refresh = useCallback(
    () =>
      execute<QueueStats[]>('refresh', async (client) => {
        const raw = await client.get(QUEUE_ADMIN_ENDPOINTS.LIST);
        const items = extractArray<QueueStats>(raw);
        setQueues(items);
        return items;
      }),
    [execute],
  );

  const refreshRedisHealth = useCallback(
    () =>
      execute<RedisHealth>('refreshRedisHealth', async (client) => {
        const data = await client.get<RedisHealth>(QUEUE_ADMIN_ENDPOINTS.REDIS_HEALTH);
        setRedisHealth(data);
        return data;
      }),
    [execute],
  );

  const listJobs = useCallback(
    (queueName: string, params?: ListJobsParams) =>
      execute<PaginatedJobs>('listJobs', async (client) => {
        const url = appendFilters(QUEUE_ADMIN_ENDPOINTS.JOBS(queueName), {
          page: params?.page !== undefined ? String(params.page) : undefined,
          limit: params?.limit !== undefined ? String(params.limit) : undefined,
          status: params?.status,
          jobName: params?.jobName,
        });
        return client.get<PaginatedJobs>(url);
      }),
    [execute],
  );

  const getJob = useCallback(
    (queueName: string, jobId: string) =>
      execute<JobDetail>('getJob', async (client) => {
        return client.get<JobDetail>(QUEUE_ADMIN_ENDPOINTS.JOB(queueName, jobId));
      }),
    [execute],
  );

  const retryJob = useCallback(
    (queueName: string, jobId: string) =>
      execute<void>('retryJob', async (client) => {
        await client.post(QUEUE_ADMIN_ENDPOINTS.RETRY_JOB(queueName, jobId), {});
      }),
    [execute],
  );

  const bulkRetry = useCallback(
    (queueName: string, jobIds: string[]) =>
      execute<BulkJobActionResult>('bulkRetry', async (client) => {
        return client.post<BulkJobActionResult>(QUEUE_ADMIN_ENDPOINTS.BULK_JOBS(queueName), { action: 'retry', jobIds });
      }),
    [execute],
  );

  return { queues, redisHealth, isLoading, error, refresh, refreshRedisHealth, listJobs, getJob, retryJob, bulkRetry };
}
