/**
 * useDnaStyle Hook Tests (DNA playground completeness)
 *
 * Covers the playground-facing additions:
 *  - generateFromHistory(sourceIds) — POST generate with selected source IDs
 *  - setDefault(reportId)           — PATCH :reportId/default, promotes report
 *  - getMyReports()                 — GET mine, the doctor's report history
 *  - getVersionDiff(reportId, a, b) — resolve two versions for a side-by-side diff
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaStyle } from '../useDnaStyle';
import { useAgenticStore } from '../../store/agenticStore';
import { DNA_STYLE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const mockReport = {
  id: 'dna-1',
  doctorId: 'd-1',
  reportData: { tone: 'formal' },
  styleText: 'Formal medical writing.',
  isLatest: true,
  currentVersionNumber: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mockVersions = [
  { id: 'v-3', dnaReportId: 'dna-1', versionNumber: 3, reportData: { tone: 'formal' }, styleText: 'v3', createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'v-2', dnaReportId: 'dna-1', versionNumber: 2, reportData: { tone: 'neutral' }, styleText: 'v2', createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'v-1', dnaReportId: 'dna-1', versionNumber: 1, reportData: { tone: 'casual' }, styleText: 'v1', createdAt: '2026-01-01T00:00:00.000Z' },
];

describe('useDnaStyle', () => {
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPatch = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockStore = {
      apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: vi.fn() },
      logger: null,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── generateFromHistory ───────────────────────────────────

  describe('generateFromHistory', () => {
    it('should POST to GENERATE with the selected sourceIds', async () => {
      mockPost.mockResolvedValue({ jobId: 'job-1' });
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.generateFromHistory(['src-1', 'src-2']);
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(DNA_STYLE_ENDPOINTS.GENERATE);
      expect(body.sourceIds).toEqual(['src-1', 'src-2']);
      expect(typeof body.idempotencyKey).toBe('string');
      expect(resp).toEqual({ jobId: 'job-1' });
    });

    it('should merge extra input (textSamples) alongside sourceIds', async () => {
      mockPost.mockResolvedValue({ jobId: 'job-2' });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.generateFromHistory(['src-1'], { textSamples: ['hello'] });
      });

      const [, body] = mockPost.mock.calls[0];
      expect(body.sourceIds).toEqual(['src-1']);
      expect(body.textSamples).toEqual(['hello']);
    });

    it('should not update style state (returns jobId)', async () => {
      mockPost.mockResolvedValue({ jobId: 'job-3' });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.generateFromHistory(['src-1']);
      });

      expect(result.current.style).toBeNull();
    });

    it('should throw when apiClient is not available', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useDnaStyle());

      await expect(
        act(async () => {
          await result.current.generateFromHistory(['src-1']);
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  // ─── setDefault ────────────────────────────────────────────

  describe('setDefault', () => {
    it('should PATCH to SET_DEFAULT(reportId) and update style', async () => {
      mockPatch.mockResolvedValue(mockReport);
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.setDefault('dna-1');
      });

      expect(mockPatch).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.SET_DEFAULT('dna-1'), {});
      expect(result.current.style).toEqual(mockReport);
      expect(resp).toEqual(mockReport);
    });

    it('should set error on failure and reset isLoading', async () => {
      mockPatch.mockRejectedValue(new Error('Set default failed'));
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        try {
          await result.current.setDefault('dna-1');
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Set default failed');
      expect(result.current.isLoading).toBe(false);
    });

    it('should throw when apiClient is not available', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useDnaStyle());

      await expect(
        act(async () => {
          await result.current.setDefault('dna-1');
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  // ─── getMyReports ──────────────────────────────────────────

  describe('getMyReports', () => {
    it('should GET from MINE and expose the doctor report history', async () => {
      const reports = [mockReport, { ...mockReport, id: 'dna-0', isLatest: false }];
      mockGet.mockResolvedValue(reports);
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getMyReports();
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.MINE);
      expect(result.current.reports).toEqual(reports);
      expect(resp).toEqual(reports);
    });

    it('should extract array from a paginated wrapper response', async () => {
      const items = [mockReport];
      mockGet.mockResolvedValue({ data: items, count: 1 });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.getMyReports();
      });

      expect(result.current.reports).toEqual(items);
    });
  });

  // ─── getVersionDiff ────────────────────────────────────────

  describe('getVersionDiff', () => {
    it('should resolve the two requested versions from the versions endpoint', async () => {
      mockGet.mockResolvedValue(mockVersions);
      const { result } = renderHook(() => useDnaStyle());

      let resp: any;
      await act(async () => {
        resp = await result.current.getVersionDiff('dna-1', 'v-1', 'v-3');
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.VERSIONS('dna-1'));
      expect(resp.left?.id).toBe('v-1');
      expect(resp.right?.id).toBe('v-3');
      expect(result.current.versions).toEqual(mockVersions);
    });

    it('should return null sides when a version id is not found', async () => {
      mockGet.mockResolvedValue(mockVersions);
      const { result } = renderHook(() => useDnaStyle());

      let resp: any;
      await act(async () => {
        resp = await result.current.getVersionDiff('dna-1', 'missing', 'v-2');
      });

      expect(resp.left).toBeNull();
      expect(resp.right?.id).toBe('v-2');
    });
  });
});
