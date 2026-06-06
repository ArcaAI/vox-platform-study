import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useAdminGenerateDnaReport,
  useAdminUpdateDnaReport,
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
const mockPatch = adminClient.patch as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;

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
        `/admin/dna-writing-styles?page=1&limit=500&includeDisabled=true&tenantId=${TENANT_ID}`,
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

  // TASK-331 doc-02 F1 — admin DNA edit must satisfy the `@RequiresIfMatch()`
  // route by forwarding the RFC 7232 `If-Match` header (CAS predicate).
  describe('useAdminUpdateDnaReport', () => {
    it('forwards ifMatch to adminClient.patch as a request option (not in the body)', async () => {
      mockPatch.mockResolvedValueOnce({ id: REPORT_ID });

      const { result } = renderHook(() => useAdminUpdateDnaReport(), { wrapper: createWrapper() });

      result.current.mutate({
        reportId: REPORT_ID,
        tenantId: TENANT_ID,
        styleText: 'Updated style',
        changeReason: 'Refinement',
        ifMatch: '"3"',
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        `/admin/dna-writing-styles/${REPORT_ID}`,
        { styleText: 'Updated style', changeReason: 'Refinement' },
        { tenantId: TENANT_ID, ifMatch: '"3"' },
      );
    });

    it('omits ifMatch from the request options when not provided', async () => {
      mockPatch.mockResolvedValueOnce({ id: REPORT_ID });

      const { result } = renderHook(() => useAdminUpdateDnaReport(), { wrapper: createWrapper() });

      result.current.mutate({ reportId: REPORT_ID, tenantId: TENANT_ID, styleText: 'No version' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        `/admin/dna-writing-styles/${REPORT_ID}`,
        { styleText: 'No version' },
        { tenantId: TENANT_ID },
      );
    });
  });

  // CC-05 (TASK-336) — the admin DNA generate endpoint
  // (`POST /admin/dna-writing-styles/generate/:doctorId`) was unreachable from
  // the console. This hook makes it reachable: it targets the selected doctor,
  // scopes the call to the active tenant, and forwards optional body fields.
  describe('useAdminGenerateDnaReport', () => {
    const DOCTOR_ID = 'doctor-9';

    it('POSTs to the admin generate route for the doctor, scoped to the tenant', async () => {
      mockPost.mockResolvedValueOnce({ jobId: 'job-1' });

      const { result } = renderHook(() => useAdminGenerateDnaReport(), { wrapper: createWrapper() });

      result.current.mutate({ doctorId: DOCTOR_ID, tenantId: TENANT_ID });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPost).toHaveBeenCalledWith(
        `/admin/dna-writing-styles/generate/${DOCTOR_ID}`,
        {},
        { tenantId: TENANT_ID },
      );
    });

    it('forwards optional generation inputs in the body (not doctorId/tenantId)', async () => {
      mockPost.mockResolvedValueOnce({ jobId: 'job-2' });

      const { result } = renderHook(() => useAdminGenerateDnaReport(), { wrapper: createWrapper() });

      result.current.mutate({
        doctorId: DOCTOR_ID,
        tenantId: TENANT_ID,
        textSamples: ['sample a', 'sample b'],
        editedSummary: 'edited',
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPost).toHaveBeenCalledWith(
        `/admin/dna-writing-styles/generate/${DOCTOR_ID}`,
        { textSamples: ['sample a', 'sample b'], editedSummary: 'edited' },
        { tenantId: TENANT_ID },
      );
    });
  });
});
