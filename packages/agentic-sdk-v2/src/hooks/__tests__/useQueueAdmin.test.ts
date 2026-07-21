/**
 * useQueueAdmin Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQueueAdmin } from '../useQueueAdmin';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { QUEUE_ADMIN_ENDPOINTS } from '../../core/constants';
import type { QueueStats, RedisHealth } from '../../types/ops-admin';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const QUEUE: QueueStats = {
  name: 'AuditLog',
  isPaused: false,
  counts: { waiting: 1, active: 0, completed: 10, failed: 2, delayed: 0, paused: 0, prioritized: 0 },
  workerCount: 1,
};

const HEALTH: RedisHealth = {
  status: 'healthy',
  latencyMs: 2,
  connectedClients: 9,
  usedMemory: '12.00M',
  uptime: 3600,
  version: '7.2.5',
  queuesRegistered: 15,
};

describe('useQueueAdmin', () => {
  const mockGet = vi.fn();
  const mockPost = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    (useAgenticStore as any).mockReturnValue({
      apiClient: { get: mockGet, post: mockPost },
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty queues and null redis health', () => {
    const { result } = renderHook(() => useQueueAdmin());
    expect(result.current.queues).toEqual([]);
    expect(result.current.redisHealth).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('refresh() GETs the queue list and stores it', async () => {
    mockGet.mockResolvedValue([QUEUE]);
    const { result } = renderHook(() => useQueueAdmin());

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGet).toHaveBeenCalledWith(QUEUE_ADMIN_ENDPOINTS.LIST);
    expect(result.current.queues).toEqual([QUEUE]);
  });

  it('refreshRedisHealth() GETs the health probe and stores it', async () => {
    mockGet.mockResolvedValue(HEALTH);
    const { result } = renderHook(() => useQueueAdmin());

    await act(async () => {
      await result.current.refreshRedisHealth();
    });

    expect(mockGet).toHaveBeenCalledWith(QUEUE_ADMIN_ENDPOINTS.REDIS_HEALTH);
    expect(result.current.redisHealth).toEqual(HEALTH);
  });

  it('listJobs() GETs the jobs endpoint with pagination + status filter query params', async () => {
    const paginated = { items: [], total: 0, page: 0, limit: 20 };
    mockGet.mockResolvedValue(paginated);
    const { result } = renderHook(() => useQueueAdmin());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.listJobs('AuditLog', { page: 2, limit: 20, status: 'failed' });
    });

    const url = mockGet.mock.calls[0][0] as string;
    expect(url).toContain(QUEUE_ADMIN_ENDPOINTS.JOBS('AuditLog'));
    expect(url).toContain('page=2');
    expect(url).toContain('limit=20');
    expect(url).toContain('status=failed');
    expect(resp).toEqual(paginated);
  });

  it('getJob() GETs the job detail', async () => {
    const detail = { id: 'job-1', name: 'audit', queueName: 'AuditLog' };
    mockGet.mockResolvedValue(detail);
    const { result } = renderHook(() => useQueueAdmin());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.getJob('AuditLog', 'job-1');
    });

    expect(mockGet).toHaveBeenCalledWith(QUEUE_ADMIN_ENDPOINTS.JOB('AuditLog', 'job-1'));
    expect(resp).toEqual(detail);
  });

  it('retryJob() POSTs the retry action', async () => {
    mockPost.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useQueueAdmin());

    await act(async () => {
      await result.current.retryJob('AuditLog', 'job-1');
    });

    expect(mockPost).toHaveBeenCalledWith(QUEUE_ADMIN_ENDPOINTS.RETRY_JOB('AuditLog', 'job-1'), {});
  });

  it('bulkRetry() POSTs a retry-only bulk action (the SDK exposes no remove)', async () => {
    mockPost.mockResolvedValue({ succeeded: 2, failed: 0 });
    const { result } = renderHook(() => useQueueAdmin());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.bulkRetry('AuditLog', ['1', '2']);
    });

    expect(mockPost).toHaveBeenCalledWith(QUEUE_ADMIN_ENDPOINTS.BULK_JOBS('AuditLog'), { action: 'retry', jobIds: ['1', '2'] });
    expect(resp).toEqual({ succeeded: 2, failed: 0 });
  });
});
