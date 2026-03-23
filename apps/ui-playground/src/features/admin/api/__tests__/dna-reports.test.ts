import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useDnaReportVersions,
  useTenantDnaReportData,
} from '../dna-reports';

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

const TENANT_ID = 'tenant-abc';
const REPORT_ID = 'report-123';

describe('DNA Reports Admin API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useDnaReportVersions', () => {
    it('should call GET /admin/dna-writing-styles/:reportId/versions with tenantId', async () => {
      const versions = [
        {
          id: 'v-1',
          dnaReportId: REPORT_ID,
          versionNumber: 1,
          reportData: { tone: 'formal' },
          styleText: 'Style v1',
          changeReason: 'Initial',
          changedBy: 'system',
          createdAt: '2025-12-01T00:00:00.000Z',
        },
        {
          id: 'v-2',
          dnaReportId: REPORT_ID,
          versionNumber: 2,
          reportData: { tone: 'casual' },
          styleText: 'Style v2',
          changeReason: 'Refinement',
          changedBy: 'doctor-1',
          createdAt: '2025-12-15T00:00:00.000Z',
        },
      ];
      mockGet.mockResolvedValueOnce(versions);

      const { result } = renderHook(
        () => useDnaReportVersions(TENANT_ID, REPORT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        `/admin/dna-writing-styles/${REPORT_ID}/versions`,
        { tenantId: TENANT_ID },
      );
    });

    it('should sort versions by versionNumber descending', async () => {
      const versions = [
        { id: 'v-1', versionNumber: 1, createdAt: '2025-12-01T00:00:00.000Z' },
        { id: 'v-2', versionNumber: 2, createdAt: '2025-12-15T00:00:00.000Z' },
      ];
      mockGet.mockResolvedValueOnce(versions);

      const { result } = renderHook(
        () => useDnaReportVersions(TENANT_ID, REPORT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data![0].versionNumber).toBe(2);
      expect(result.current.data![1].versionNumber).toBe(1);
    });

    it('should not fetch when tenantId is empty', async () => {
      const { result } = renderHook(
        () => useDnaReportVersions('', REPORT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should not fetch when reportId is empty', async () => {
      const { result } = renderHook(
        () => useDnaReportVersions(TENANT_ID, ''),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useTenantDnaReportData', () => {
    it('should call admin endpoints for users and reports', async () => {
      mockGet
        .mockResolvedValueOnce({ data: [{ id: 'u-1', username: 'doc1' }], count: 1, limit: 100, page: 1 })
        .mockResolvedValueOnce({ data: [{ id: 'r-1', doctorId: 'u-1' }], count: 1, limit: 500, page: 1 });

      const { result } = renderHook(
        () => useTenantDnaReportData(TENANT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        `/admin/users/tenant/${TENANT_ID}?page=1&limit=100`,
        { tenantId: TENANT_ID },
      );
      expect(mockGet).toHaveBeenCalledWith(
        '/admin/dna-writing-styles?page=1&limit=500&includeDisabled=true',
        { tenantId: TENANT_ID },
      );
    });

    it('should not fetch when tenantId is empty', async () => {
      const { result } = renderHook(
        () => useTenantDnaReportData(''),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
