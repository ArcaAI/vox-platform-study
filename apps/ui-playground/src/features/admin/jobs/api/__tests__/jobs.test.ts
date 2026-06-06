import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAdminConsultations, useAdminTranscriptionJobs, useTranscriptionJobStats } from '../jobs';

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

const TENANT_ID = 'tenant-1';

// ---------------------------------------------------------------------------
// OB-02 — admin job-observability hooks must hit the EXISTING tenant-wide
// controllers and read each list's own pagination envelope.
// ---------------------------------------------------------------------------
describe('Admin Jobs (OB-02) API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useAdminConsultations', () => {
    it('GETs /admin/consultations with paging + tenant scope', async () => {
      mockGet.mockResolvedValueOnce({ data: [], count: 0, page: 1, limit: 10 });

      const { result } = renderHook(() => useAdminConsultations(TENANT_ID, { page: 1, limit: 10 }), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/consultations?page=1&limit=10', { tenantId: TENANT_ID });
    });

    it('forwards optional filters (doctorId / departmentId / patientId)', async () => {
      mockGet.mockResolvedValueOnce({ data: [], count: 0, page: 2, limit: 25 });

      const { result } = renderHook(
        () => useAdminConsultations(TENANT_ID, { page: 2, limit: 25, doctorId: 'doc-1', departmentId: 'dep-1' }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/consultations?page=2&limit=25&doctorId=doc-1&departmentId=dep-1', { tenantId: TENANT_ID });
    });

    it('reads the admin `count` envelope (not `total`)', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'c-1' }], count: 42, page: 1, limit: 10 });

      const { result } = renderHook(() => useAdminConsultations(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.count).toBe(42);
    });

    it('does not fetch without a tenant', async () => {
      const { result } = renderHook(() => useAdminConsultations(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useAdminTranscriptionJobs', () => {
    it('GETs /admin/audio/transcription-jobs with paging + tenant scope', async () => {
      mockGet.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });

      const { result } = renderHook(() => useAdminTranscriptionJobs(TENANT_ID, { page: 1, limit: 20 }), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/audio/transcription-jobs?page=1&limit=20', { tenantId: TENANT_ID });
    });

    it('reads the `total` envelope (distinct from the consultation `count`)', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'j-1' }], total: 7, page: 1, limit: 20, totalPages: 1 });

      const { result } = renderHook(() => useAdminTranscriptionJobs(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.total).toBe(7);
    });

    it('does not fetch without a tenant', async () => {
      const { result } = renderHook(() => useAdminTranscriptionJobs(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useTranscriptionJobStats', () => {
    it('GETs /admin/audio/transcription-jobs/stats with tenant scope', async () => {
      mockGet.mockResolvedValueOnce({ queued: 1, processing: 2, completed: 3, failed: 0, cancelled: 0, dead: 0 });

      const { result } = renderHook(() => useTranscriptionJobStats(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/audio/transcription-jobs/stats', { tenantId: TENANT_ID });
      expect(result.current.data?.processing).toBe(2);
    });

    it('does not fetch without a tenant', async () => {
      const { result } = renderHook(() => useTranscriptionJobStats(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
