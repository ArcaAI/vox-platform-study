/**
 * Local DNA API hooks — TASK-329 P5.
 *
 * Covers the playground additions to the adminClient-backed api layer:
 *  - useMyDnaReports()        → GET /dna-writing-styles/mine
 *  - useSetDefaultDnaReport() → PATCH /dna-writing-styles/:id/default (optimistic)
 *  - applyDefaultToReports()  → pure optimistic-cache transform
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockGet, mockPatch, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('../../admin/api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  adminClient: { get: mockGet, patch: mockPatch, post: mockPost },
}));

import { applyDefaultToReports, dnaWritingStyleKeys, useMyDnaReports, useSetDefaultDnaReport, type DnaReport } from '../api/dna-writing-styles';

const REPORTS: DnaReport[] = [
  { id: 'r1', doctorId: 'd1', reportData: null, isLatest: true, currentVersionNumber: 2, createdAt: '', updatedAt: '' },
  { id: 'r2', doctorId: 'd1', reportData: null, isLatest: false, currentVersionNumber: 1, createdAt: '', updatedAt: '' },
];

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

describe('applyDefaultToReports', () => {
  it('marks the target report latest and demotes the rest', () => {
    const next = applyDefaultToReports(REPORTS, 'r2');
    expect(next.find((r) => r.id === 'r2')?.isLatest).toBe(true);
    expect(next.find((r) => r.id === 'r1')?.isLatest).toBe(false);
  });

  it('is a no-op-safe on an unknown id (still exactly one latest at most)', () => {
    const next = applyDefaultToReports(REPORTS, 'missing');
    expect(next.filter((r) => r.isLatest)).toHaveLength(0);
  });
});

describe('useMyDnaReports', () => {
  afterEach(() => vi.clearAllMocks());

  it('GETs the owner-scoped /mine endpoint', async () => {
    mockGet.mockResolvedValue(REPORTS);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useMyDnaReports(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/dna-writing-styles/mine');
    expect(result.current.data).toHaveLength(2);
  });
});

describe('useSetDefaultDnaReport', () => {
  afterEach(() => vi.clearAllMocks());

  it('PATCHes the :id/default endpoint', async () => {
    mockPatch.mockResolvedValue({ ...REPORTS[1], isLatest: true });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useSetDefaultDnaReport(), { wrapper });
    result.current.mutate('r2');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/dna-writing-styles/r2/default', {});
  });

  it('optimistically promotes the report in the cached /mine list', async () => {
    let resolvePatch: (v: unknown) => void = () => {};
    mockPatch.mockReturnValue(
      new Promise((res) => {
        resolvePatch = res;
      }),
    );
    const { qc, wrapper } = makeWrapper();
    qc.setQueryData(dnaWritingStyleKeys.mine(), REPORTS);

    const { result } = renderHook(() => useSetDefaultDnaReport(), { wrapper });
    result.current.mutate('r2');

    await waitFor(() => {
      const cached = qc.getQueryData<DnaReport[]>(dnaWritingStyleKeys.mine());
      expect(cached?.find((r) => r.id === 'r2')?.isLatest).toBe(true);
      expect(cached?.find((r) => r.id === 'r1')?.isLatest).toBe(false);
    });

    resolvePatch({ ...REPORTS[1], isLatest: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
