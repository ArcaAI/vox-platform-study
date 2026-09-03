/**
 * / REST review H-1 phase 0b — the SDK sends `If-Match` on the
 * tier-A routes it drives.
 *
 * Two of the seven flipped routes are reachable from the BROWSER SDK:
 *
 *   `PATCH /consultations/:id` — `useArcaSession.update` / `useArca.updateConsultation`
 *   `PATCH /dna-writing-styles/:reportId/default` — `useDnaStyle.setDefault`
 *
 * The contract these tests pin, in both directions:
 *
 *   1. when the SDK HOLDS the row version it read, it echoes it as the strong
 *      validator `"<version>"` (`patchWithIfMatch`);
 *   2. when it holds NO version it sends no precondition at all
 *      (`patch`) — it must never invent one, because a fabricated validator
 *      turns a 428 ("you forgot the header") into either a spurious 412 or, on
 *      a lucky guess, a CAS that certifies a comparison nobody made;
 *   3. a 412 is surfaced as a `ConfigConflictError` — a "refetch and retry"
 *      outcome — not a generic failure.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';
import { useDnaStyle } from '../useDnaStyle';
import { CONSULTATION_ENDPOINTS, DNA_STYLE_ENDPOINTS } from '../../core/constants';
import { ConfigConflictError } from '../../types/settings';
import { AgenticError } from '../../types/common';

const mockPatch = vi.fn();
const mockPatchWithIfMatch = vi.fn();

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: mockPatch,
  patchWithIfMatch: mockPatchWithIfMatch,
  postWithHeaders: vi.fn(),
  delete: vi.fn(),
};

const consultation = { id: 'c-1', patientId: 'p-1', doctorId: 'd-1', appointmentDate: '2026-08-20', createdAt: '', updatedAt: '', version: 4 };

const mockStore: Record<string, unknown> = {
  apiClient,
  consultation,
  logger: null,
  initialized: true,
  summaries: [],
  contextItems: [],
  sharedContext: [],
  entities: [],
  setConsultation: vi.fn(),
  setSummaries: vi.fn(),
  setContextItems: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  setTranscriptions: vi.fn(),
  clearSession: vi.fn(),
};

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => (typeof selector === 'function' ? selector(mockStore) : mockStore)),
  selectApiClient: (s: Record<string, unknown>) => s.apiClient,
  selectConsultation: (s: Record<string, unknown>) => s.consultation,
  selectContextItems: (s: Record<string, unknown>) => s.contextItems,
  selectSharedContext: (s: Record<string, unknown>) => s.sharedContext,
  selectEntities: (s: Record<string, unknown>) => s.entities,
  selectLogger: (s: Record<string, unknown>) => s.logger,
  selectTranscriptions: () => [],
  selectSummaries: () => [],
  selectCaseNotes: () => [],
  selectWorknotes: () => [],
  selectAttachments: () => [],
}));

// `useDnaStyle` reads the store through the legacy module accessor.
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn(() => mockStore) };
});

const conflict = () => new AgenticError('UNKNOWN_ERROR', 'HTTP 412', { context: { status: 412, currentVersion: 9 } });

describe(' phase 0b — SDK sends If-Match on the tier-A routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.consultation = { ...consultation };
  });

  describe('PATCH /consultations/:id — useArcaSession.update', () => {
    it('echoes the version the SDK read as a strong If-Match validator', async () => {
      mockPatchWithIfMatch.mockResolvedValue({ ...consultation, version: 5 });
      const { result } = renderHook(() => useArcaSession());

      await act(async () => {
        await result.current.update({ metadata: { note: 'x' } });
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(CONSULTATION_ENDPOINTS.UPDATE('c-1'), { metadata: { note: 'x' } }, '"4"');
      expect(mockPatch, 'the unconditional PATCH must not be used when a version is known').not.toHaveBeenCalled();
    });

    it('sends NO If-Match when the loaded consultation carries no version', async () => {
      mockStore.consultation = { ...consultation, version: undefined };
      mockPatch.mockResolvedValue({ ...consultation, version: undefined });
      const { result } = renderHook(() => useArcaSession());

      await act(async () => {
        await result.current.update({ metadata: { note: 'x' } });
      });

      expect(mockPatch).toHaveBeenCalledWith(CONSULTATION_ENDPOINTS.UPDATE('c-1'), { metadata: { note: 'x' } });
      expect(mockPatchWithIfMatch, 'a validator must never be invented').not.toHaveBeenCalled();
    });

    it('surfaces a 412 as a ConfigConflictError (refetch-and-retry), not a generic failure', async () => {
      mockPatchWithIfMatch.mockRejectedValue(conflict());
      const { result } = renderHook(() => useArcaSession());

      await expect(
        act(async () => {
          await result.current.update({ metadata: { note: 'x' } });
        }),
      ).rejects.toBeInstanceOf(ConfigConflictError);
    });
  });

  describe('PATCH /dna-writing-styles/:reportId/default — useDnaStyle.setDefault', () => {
    const report = { id: 'dna-2', doctorId: 'd-1', reportData: {}, isLatest: false, currentVersionNumber: 3, createdAt: '', updatedAt: '', version: 6 };

    it('echoes the version from the report list the SDK loaded', async () => {
      apiClient.get.mockResolvedValue([report]);
      mockPatchWithIfMatch.mockResolvedValue({ ...report, isLatest: true, version: 7 });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.getMyReports();
      });
      await act(async () => {
        await result.current.setDefault('dna-2');
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.SET_DEFAULT('dna-2'), {}, '"6"');
    });

    it('prefers an explicitly supplied version over the loaded one', async () => {
      apiClient.get.mockResolvedValue([report]);
      mockPatchWithIfMatch.mockResolvedValue({ ...report, isLatest: true, version: 12 });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.getMyReports();
      });
      await act(async () => {
        await result.current.setDefault('dna-2', 11);
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.SET_DEFAULT('dna-2'), {}, '"11"');
    });

    it('sends NO If-Match for a report whose version the SDK never read', async () => {
      mockPatch.mockResolvedValue({ ...report, isLatest: true });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.setDefault('never-loaded');
      });

      expect(mockPatch).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.SET_DEFAULT('never-loaded'), {});
      expect(mockPatchWithIfMatch).not.toHaveBeenCalled();
    });

    it('surfaces a 412 as a ConfigConflictError', async () => {
      apiClient.get.mockResolvedValue([report]);
      mockPatchWithIfMatch.mockRejectedValue(conflict());
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.getMyReports();
      });

      let captured: unknown;
      await act(async () => {
        await result.current.setDefault('dna-2').catch((error: unknown) => {
          captured = error;
        });
      });

      expect(captured).toBeInstanceOf(ConfigConflictError);
    });
  });
});
