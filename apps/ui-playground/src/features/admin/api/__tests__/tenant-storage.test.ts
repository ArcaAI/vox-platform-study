/**
 * Tenant storage admin-API hooks (TASK-331 doc-03 F7)
 *
 * Pins the object data-plane to the ADMIN plane: object LIST, UPLOAD and DELETE
 * all route through `/admin/tenants/storage/buckets/:bucketId/objects` (by
 * bucket id), NOT the legacy non-admin `/storage/buckets/:name/files` plane.
 *
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useDeleteTenantBucketObject, useTenantBucketObjects, useUploadTenantObject } from '../tenant-storage';

vi.mock('../admin-client', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}));

import { adminClient } from '../admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockUpload = adminClient.upload as ReturnType<typeof vi.fn>;
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

const TENANT_ID = 'tenant-abc';
const BUCKET_ID = 'bucket-123';

describe('Tenant storage admin API hooks (TASK-331 doc-03 F7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useTenantBucketObjects', () => {
    it('lists objects via the admin plane by bucket id (no prefix)', async () => {
      mockGet.mockResolvedValueOnce([{ key: 'a.wav', size: 10 }]);

      const { result } = renderHook(() => useTenantBucketObjects(TENANT_ID, BUCKET_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/tenants/storage/buckets/${BUCKET_ID}/objects`, { tenantId: TENANT_ID });
    });

    it('appends a normalized prefix query', async () => {
      mockGet.mockResolvedValueOnce([]);

      const { result } = renderHook(() => useTenantBucketObjects(TENANT_ID, BUCKET_ID, 'patients/2026'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        `/admin/tenants/storage/buckets/${BUCKET_ID}/objects?prefix=${encodeURIComponent('patients/2026/')}`,
        { tenantId: TENANT_ID },
      );
    });

    it('does not fetch when the bucket id is empty', async () => {
      const { result } = renderHook(() => useTenantBucketObjects(TENANT_ID, ''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useUploadTenantObject', () => {
    it('uploads via the admin plane by bucket id with the joined key', async () => {
      mockUpload.mockResolvedValueOnce({ key: 'patients/a.wav', size: 5 });

      const { result } = renderHook(() => useUploadTenantObject(), { wrapper: createWrapper() });

      result.current.mutate({
        tenantId: TENANT_ID,
        bucketId: BUCKET_ID,
        file: new Blob(['hi']),
        fileName: 'a.wav',
        path: 'patients',
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockUpload).toHaveBeenCalledWith(
        `/admin/tenants/storage/buckets/${BUCKET_ID}/objects?key=${encodeURIComponent('patients/a.wav')}`,
        expect.any(FormData),
        { tenantId: TENANT_ID },
      );
    });
  });

  describe('useDeleteTenantBucketObject', () => {
    it('deletes via the admin plane by bucket id and key', async () => {
      mockDelete.mockResolvedValueOnce({ key: 'a.wav', deleted: true });

      const { result } = renderHook(() => useDeleteTenantBucketObject(TENANT_ID), { wrapper: createWrapper() });

      result.current.mutate({ bucketId: BUCKET_ID, bucketName: 'hope-audio-arcaai', fileKey: '2026/a.wav' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockDelete).toHaveBeenCalledWith(
        `/admin/tenants/storage/buckets/${BUCKET_ID}/objects?key=${encodeURIComponent('2026/a.wav')}`,
        { tenantId: TENANT_ID },
      );
    });
  });
});
