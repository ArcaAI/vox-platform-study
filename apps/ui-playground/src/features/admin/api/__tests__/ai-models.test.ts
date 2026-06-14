/**
 * AI model admin API hooks — TASK-356 Phase 1 (Catalog plane).
 *
 * Mirrors `audio-pipelines.test.ts`: the admin list targets `/admin/ai-models`
 * with the tenant scope, and the update mutation carries the OCC `If-Match`
 * header alongside the body-field `expectedVersion`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAiModels, useUpdateAiModel } from '../ai-models';

vi.mock('../admin-client', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
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

const TENANT_ID = 'tenant-1';

describe('AI model API hooks (TASK-356 Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useAiModels (exact-tenant admin list)', () => {
    it('GETs /admin/ai-models with the tenant scope (X-Tenant-Id)', async () => {
      mockGet.mockResolvedValueOnce([]);

      const { result } = renderHook(() => useAiModels(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/ai-models', { tenantId: TENANT_ID });
    });

    it('does not fetch when no tenant is selected', async () => {
      const { result } = renderHook(() => useAiModels(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useUpdateAiModel (OCC)', () => {
    it('PATCHes with the If-Match header and the body-field expectedVersion', async () => {
      mockPatch.mockResolvedValueOnce({ id: 'm1', version: 8 });

      const { result } = renderHook(() => useUpdateAiModel(TENANT_ID), { wrapper: createWrapper() });

      result.current.mutate({ id: 'm1', name: 'Updated', expectedVersion: 7, ifMatch: '"7"' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        '/admin/ai-models/m1',
        { name: 'Updated', expectedVersion: 7 },
        { tenantId: TENANT_ID, ifMatch: '"7"' },
      );
    });

    it('falls back to tenant-only options when ifMatch is omitted', async () => {
      mockPatch.mockResolvedValueOnce({ id: 'm1', version: 8 });

      const { result } = renderHook(() => useUpdateAiModel(TENANT_ID), { wrapper: createWrapper() });

      result.current.mutate({ id: 'm1', name: 'Updated', expectedVersion: 7 });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith('/admin/ai-models/m1', { name: 'Updated', expectedVersion: 7 }, { tenantId: TENANT_ID });
    });
  });
});
