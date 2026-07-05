import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useQueues,
  useQueueJobs,
  useQueueJob,
  usePauseQueue,
  useResumeQueue,
  useCleanQueue,
  useRetryJob,
  usePromoteJob,
  useRemoveJob,
  useBulkJobAction,
} from '../queues';

vi.mock('../../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    deleteWithBody: vi.fn(),
  },
}));

import { adminClient } from '../../../api/admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;
const mockDelete = adminClient.delete as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const QUEUE = 'SendEmail';

// ---------------------------------------------------------------------------
// OB-03 — surface the EXISTING GLOBAL_ADMIN queue-admin API (TASK-250). The
// hooks must hit the exact controller routes with the typed bodies. NOTE the
// job list `page` is ZERO-BASED (distinct from the 1-based consultation list).
// ---------------------------------------------------------------------------
describe('Queues (OB-03) API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useQueues GETs /admin/queues', async () => {
    mockGet.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useQueues(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/queues');
  });

  it('useQueueJobs GETs the nested jobs route with a zero-based page + filters', async () => {
    mockGet.mockResolvedValueOnce({ items: [], total: 0, page: 0, limit: 20 });

    const { result } = renderHook(() => useQueueJobs(QUEUE, { page: 0, limit: 20, status: 'failed', jobName: 'welcome' }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs?page=0&limit=20&status=failed&jobName=welcome');
  });

  it('useQueueJobs is disabled until a queue is selected', () => {
    const { result } = renderHook(() => useQueueJobs('', { page: 0, limit: 20 }), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('useQueueJob GETs a single (redacted) job', async () => {
    mockGet.mockResolvedValueOnce({ id: '42', name: 'send', queueName: QUEUE });

    const { result } = renderHook(() => useQueueJob(QUEUE, '42'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs/42');
  });

  it('useQueueJob is disabled until a job is selected', () => {
    const { result } = renderHook(() => useQueueJob(QUEUE, ''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('usePauseQueue POSTs /admin/queues/:queueName/pause', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => usePauseQueue(), { wrapper: createWrapper() });
    result.current.mutate(QUEUE);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/pause');
  });

  it('useResumeQueue POSTs /admin/queues/:queueName/resume', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useResumeQueue(), { wrapper: createWrapper() });
    result.current.mutate(QUEUE);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/resume');
  });

  it('useCleanQueue POSTs /admin/queues/:queueName/clean with the typed body', async () => {
    mockPost.mockResolvedValueOnce({ removedJobIds: ['1', '2'], count: 2 });

    const { result } = renderHook(() => useCleanQueue(), { wrapper: createWrapper() });
    result.current.mutate({ queueName: QUEUE, status: 'completed', gracePeriodMs: 86_400_000, limit: 1000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/clean', { status: 'completed', gracePeriodMs: 86_400_000, limit: 1000 });
  });

  it('useRetryJob POSTs /admin/queues/:queueName/jobs/:jobId/retry', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useRetryJob(), { wrapper: createWrapper() });
    result.current.mutate({ queueName: QUEUE, jobId: '42' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs/42/retry');
  });

  it('usePromoteJob POSTs /admin/queues/:queueName/jobs/:jobId/promote', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => usePromoteJob(), { wrapper: createWrapper() });
    result.current.mutate({ queueName: QUEUE, jobId: '42' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs/42/promote');
  });

  it('useRemoveJob DELETEs /admin/queues/:queueName/jobs/:jobId', async () => {
    mockDelete.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useRemoveJob(), { wrapper: createWrapper() });
    result.current.mutate({ queueName: QUEUE, jobId: '42' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs/42');
  });

  it('useBulkJobAction POSTs /admin/queues/:queueName/jobs/bulk with {action, jobIds}', async () => {
    mockPost.mockResolvedValueOnce({ succeeded: 2, failed: 0 });

    const { result } = renderHook(() => useBulkJobAction(), { wrapper: createWrapper() });
    result.current.mutate({ queueName: QUEUE, action: 'retry', jobIds: ['1', '2'] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/queues/SendEmail/jobs/bulk', { action: 'retry', jobIds: ['1', '2'] });
  });
});
