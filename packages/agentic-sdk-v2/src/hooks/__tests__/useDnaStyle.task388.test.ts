/**
 * useDnaStyle Hook Tests — admin cross-user (PHI-gated) methods.
 *
 * The admin methods target the `/admin/dna-writing-styles` controller, which
 * requires `manage:DnaWritingStyleReport` and tenant-scopes the caller (even
 * SUPER_ADMIN cannot cross tenants). These are distinct from the self-only
 * `getByDoctor`/`getVersions` methods that hit the end-user routes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaStyle } from '../useDnaStyle';
import { useAgenticStore } from '../../store/agenticStore';
import { DNA_STYLE_ENDPOINTS } from '../../core/constants';

function createMockLogger() {
  return {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    http: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withMeta: vi.fn().mockReturnThis(),
    withCorrelation: vi.fn().mockReturnThis(),
    withUser: vi.fn().mockReturnThis(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn().mockReturnValue('mock-correlation-id'),
    generateCorrelationId: vi.fn().mockReturnValue('generated-correlation-id'),
    startOperation: vi.fn().mockReturnValue({
      name: 'mock-operation',
      startTime: Date.now(),
      end: vi.fn(),
      error: vi.fn(),
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    getLevel: vi.fn().mockReturnValue('info'),
    setLevel: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    addTransport: vi.fn(),
    getTransportNames: vi.fn().mockReturnValue(['mock']),
  };
}

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const mockReport = {
  id: 'dna-1',
  doctorId: 'd-1',
  departmentId: 'dept-1',
  reportData: { formality: 'formal' },
  styleText: 'Formal medical writing.',
  isLatest: true,
  currentVersionNumber: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useDnaStyle — admin cross-user methods', () => {
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockStore = {
      apiClient: { get: mockGet, post: mockPost, patch: vi.fn(), delete: vi.fn() },
      logger: createMockLogger(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('adminGetReportForDoctor', () => {
    it('GETs the ADMIN_BY_DOCTOR route and updates style', async () => {
      mockGet.mockResolvedValue(mockReport);
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.adminGetReportForDoctor('d-1');
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.ADMIN_BY_DOCTOR('d-1'));
      expect(resp).toEqual(mockReport);
      expect(result.current.style).toEqual(mockReport);
    });
  });

  describe('adminGetVersions', () => {
    it('GETs the ADMIN_VERSIONS route and returns the array', async () => {
      const versions = [
        { id: 'v-1', versionNumber: 1 },
        { id: 'v-2', versionNumber: 2 },
      ];
      mockGet.mockResolvedValue(versions);
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.adminGetVersions('r-1');
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.ADMIN_VERSIONS('r-1'));
      expect(resp).toEqual(versions);
    });
  });

  describe('adminGenerateForDoctor', () => {
    it('POSTs the GENERATE_FOR_DOCTOR route and returns the jobId', async () => {
      mockPost.mockResolvedValue({ jobId: 'job-9' });
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.adminGenerateForDoctor('d-1', { textSamples: ['note'] });
      });

      expect(mockPost).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR('d-1'), expect.objectContaining({ textSamples: ['note'] }));
      expect(resp).toEqual({ jobId: 'job-9' });
    });
  });

  describe('adminListReports', () => {
    it('GETs the ADMIN_LIST route with the doctorId filter', async () => {
      mockGet.mockResolvedValue({ data: [mockReport], count: 1, page: 1, limit: 10 });
      const { result } = renderHook(() => useDnaStyle());

      let resp: any;
      await act(async () => {
        resp = await result.current.adminListReports({ doctorId: 'd-1' });
      });

      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl.startsWith(DNA_STYLE_ENDPOINTS.ADMIN_LIST)).toBe(true);
      expect(calledUrl).toContain('doctorId=d-1');
      expect(resp.data).toHaveLength(1);
      expect(resp.count).toBe(1);
    });
  });
});
