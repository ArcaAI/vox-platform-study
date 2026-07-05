import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSchedulers, usePauseScheduler, useResumeScheduler, useUpdateSchedulerCron, useToggleScheduler } from '../schedulers';

vi.mock('../../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../../../api/admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;
const mockPatch = adminClient.patch as ReturnType<typeof vi.fn>;

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

const NAME = 'dna-regeneration';

// ---------------------------------------------------------------------------
// OB-03 — surface the EXISTING GLOBAL_ADMIN scheduler-admin API (TASK-250).
// Only `dynamic` schedulers accept cron/toggle edits; the hooks just hit the
// routes — the server rejects edits to static schedulers.
// ---------------------------------------------------------------------------
describe('Schedulers (OB-03) API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useSchedulers GETs /admin/schedulers', async () => {
    mockGet.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useSchedulers(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/schedulers');
  });

  it('usePauseScheduler POSTs /admin/schedulers/:name/pause', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => usePauseScheduler(), { wrapper: createWrapper() });
    result.current.mutate(NAME);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/schedulers/dna-regeneration/pause');
  });

  it('useResumeScheduler POSTs /admin/schedulers/:name/resume', async () => {
    mockPost.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useResumeScheduler(), { wrapper: createWrapper() });
    result.current.mutate(NAME);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/schedulers/dna-regeneration/resume');
  });

  it('useUpdateSchedulerCron PATCHes /admin/schedulers/:name/cron with {cronExpression}', async () => {
    mockPatch.mockResolvedValueOnce({ name: NAME, cronExpression: '0 2 * * *' });

    const { result } = renderHook(() => useUpdateSchedulerCron(), { wrapper: createWrapper() });
    result.current.mutate({ name: NAME, cronExpression: '0 2 * * *' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/admin/schedulers/dna-regeneration/cron', { cronExpression: '0 2 * * *' });
  });

  it('useToggleScheduler PATCHes /admin/schedulers/:name/toggle with {enabled}', async () => {
    mockPatch.mockResolvedValueOnce({ name: NAME, running: false });

    const { result } = renderHook(() => useToggleScheduler(), { wrapper: createWrapper() });
    result.current.mutate({ name: NAME, enabled: false });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/admin/schedulers/dna-regeneration/toggle', { enabled: false });
  });
});
