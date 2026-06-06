import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as auditLogsApi from '../audit-logs';
import { normalizeAuditLogList, useTenantAuditLogs } from '../audit-logs';

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

describe('Audit log API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // OB-06 (TASK-336) — one canonical list envelope for the audit FE client.
  // A small normalizer maps whatever the API returns onto the admin-console
  // shape `{ data, count, limit, page }`, tolerating count/total, limit/
  // pageSize and data/items drift so the consumer never silently reads 0.
  // -------------------------------------------------------------------------
  describe('normalizeAuditLogList (OB-06)', () => {
    it('passes the canonical { data, count, limit, page } envelope through unchanged', () => {
      expect(normalizeAuditLogList({ data: [{ id: 'a' }], count: 7, limit: 25, page: 2 })).toEqual({
        data: [{ id: 'a' }],
        count: 7,
        limit: 25,
        page: 2,
      });
    });

    it('maps a total/pageSize/items response onto count/limit/data', () => {
      expect(normalizeAuditLogList({ items: [{ id: 'a' }], total: 7, pageSize: 25, page: 2 })).toEqual({
        data: [{ id: 'a' }],
        count: 7,
        limit: 25,
        page: 2,
      });
    });

    it('defaults safely for an empty/garbage response', () => {
      expect(normalizeAuditLogList(undefined)).toEqual({ data: [], count: 0, limit: 0, page: 1 });
    });
  });

  describe('useTenantAuditLogs (OB-06)', () => {
    it('returns a normalized { data, count, limit, page } envelope', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'a1' }], count: 3, limit: 25, page: 1 });

      const { result } = renderHook(() => useTenantAuditLogs(TENANT_ID, { page: 1, limit: 25 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ data: [{ id: 'a1' }], count: 3, limit: 25, page: 1 });
    });

    it('tolerates a total/pageSize/items API shape (no silent count drop)', async () => {
      mockGet.mockResolvedValueOnce({ items: [{ id: 'a1' }], total: 3, pageSize: 25, page: 1 });

      const { result } = renderHook(() => useTenantAuditLogs(TENANT_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ data: [{ id: 'a1' }], count: 3, limit: 25, page: 1 });
    });

    it('scopes the request to the tenant filter and createdAt:desc sort', async () => {
      mockGet.mockResolvedValueOnce({ data: [], count: 0, limit: 25, page: 1 });

      const { result } = renderHook(() => useTenantAuditLogs(TENANT_ID, { page: 1, limit: 25 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockGet.mock.calls[0][0] as string;
      expect(url).toContain('/admin/audit-logs?');
      expect(url).toContain(encodeURIComponent('tenantId[equals]:tenant-1'));
      expect(url).toContain('sort=createdAt%3Adesc');
    });

    it('does not fetch without a tenant id', async () => {
      const { result } = renderHook(() => useTenantAuditLogs(''), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // OB-09 (TASK-336) — collapse to ONE audit client. The unused parallel
  // hooks were removed so there is a single source of truth.
  // OB-10 (TASK-336) — audit logs are append-only: the delete mutation hook
  // was removed alongside the backend route.
  // -------------------------------------------------------------------------
  describe('single audit client (OB-09 / OB-10)', () => {
    it.each(['useAuditLogs', 'useAuditLog', 'useAuditLogsByResource', 'useAuditLogsByUser', 'useDeleteAuditLog'])(
      'no longer exports the dead hook %s',
      (name) => {
        expect((auditLogsApi as Record<string, unknown>)[name]).toBeUndefined();
      },
    );

    it('keeps the one canonical tenant-list hook', () => {
      expect(typeof auditLogsApi.useTenantAuditLogs).toBe('function');
    });
  });
});
