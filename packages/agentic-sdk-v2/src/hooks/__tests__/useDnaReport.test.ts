/**
 * useDnaReport Hook Tests (TASK-991)
 *
 * The doctor SELF-service surface over the DNA report: my-style/mine,
 * redaction rules (read-only here — written via `updateReport`), the report
 * PATCH (If-Match), the settings GET/PUT (If-Match, with the `version: 0`
 * bootstrap quirk), and generate + job-status poll.
 *
 * Mirrors the mocking style of `usePipelines.test.ts` (OCC via
 * `patchWithIfMatch`/`putWithIfMatch`) and the fake-timer polling style of
 * `useDnaWritingStyle.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaReport } from '../useDnaReport';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { DNA_WRITING_STYLE_ENDPOINTS } from '../../core/constants';
import type { DnaReport, DnaRedactionRuleSet, DnaSettings, DnaGenerateJobResponse, DnaJobStatus } from '../../types/dna';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const report: DnaReport = {
  id: 'report-1',
  doctorId: 'doctor-1',
  reportData: { formality: 'high' },
  isLatest: true,
  currentVersionNumber: 1,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  version: 1,
};

describe('useDnaReport', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPatchWithIfMatch = vi.fn();
  const mockPutWithIfMatch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatchWithIfMatch.mockReset();
    mockPutWithIfMatch.mockReset();

    mockStore = {
      apiClient: {
        get: mockGet,
        post: mockPost,
        patch: vi.fn(),
        patchWithIfMatch: mockPatchWithIfMatch,
        put: vi.fn(),
        putWithIfMatch: mockPutWithIfMatch,
        delete: vi.fn(),
      },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns null/empty state and no error', () => {
      const { result } = renderHook(() => useDnaReport());
      expect(result.current.myStyle).toBeNull();
      expect(result.current.myReports).toEqual([]);
      expect(result.current.redactionRules).toBeNull();
      expect(result.current.settings).toBeNull();
      expect(result.current.job).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('getMyStyle', () => {
    it('GETs MY_STYLE and stores the report', async () => {
      mockGet.mockResolvedValue(report);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getMyStyle();
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.MY_STYLE);
      expect(resp).toEqual(report);
      expect(result.current.myStyle).toEqual(report);
    });
  });

  describe('listMyReports', () => {
    it('GETs MINE and extracts an array response', async () => {
      mockGet.mockResolvedValue([report]);
      const { result } = renderHook(() => useDnaReport());

      await act(async () => {
        await result.current.listMyReports();
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.MINE);
      expect(result.current.myReports).toEqual([report]);
    });

    it('extracts a { data: [...] } paginated wrapper', async () => {
      mockGet.mockResolvedValue({ data: [report] });
      const { result } = renderHook(() => useDnaReport());

      await act(async () => {
        await result.current.listMyReports();
      });

      expect(result.current.myReports).toEqual([report]);
    });
  });

  describe('getMyRedactionRules', () => {
    it('GETs MY_STYLE_REDACTION_RULES and stores the rule set', async () => {
      const rules: DnaRedactionRuleSet = { rules: [{ id: 'r-1', type: 'remove', match: 'literal', pattern: 'SSN' }] };
      mockGet.mockResolvedValue(rules);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getMyRedactionRules();
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.MY_STYLE_REDACTION_RULES);
      expect(resp).toEqual(rules);
      expect(result.current.redactionRules).toEqual(rules);
    });
  });

  describe('getSettings', () => {
    it('GETs SETTINGS and stores the settings', async () => {
      const settings: DnaSettings = { doctorToggle: null, tenantEnabled: true, effective: true, version: 0 };
      mockGet.mockResolvedValue(settings);
      const { result } = renderHook(() => useDnaReport());

      await act(async () => {
        await result.current.getSettings();
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.SETTINGS);
      expect(result.current.settings).toEqual(settings);
    });
  });

  describe('updateReport', () => {
    it('PATCHes with If-Match derived from expectedVersion and stores the result', async () => {
      const updated = { ...report, styleText: 'Updated', version: 2 };
      mockPatchWithIfMatch.mockResolvedValue(updated);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.updateReport('report-1', { styleText: 'Updated' }, 1);
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(
        DNA_WRITING_STYLE_ENDPOINTS.UPDATE_REPORT('report-1'),
        { styleText: 'Updated' },
        '"1"',
      );
      expect(resp).toEqual(updated);
      expect(result.current.myStyle).toEqual(updated);
    });

    it('writes redactionRules through the same PATCH (no dedicated write route)', async () => {
      mockPatchWithIfMatch.mockResolvedValue(report);
      const { result } = renderHook(() => useDnaReport());
      const redactionRules = { rules: [{ id: 'r-1', type: 'remove', match: 'literal', pattern: 'SSN' }] };

      await act(async () => {
        await result.current.updateReport('report-1', { redactionRules }, 3);
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.UPDATE_REPORT('report-1'), { redactionRules }, '"3"');
    });
  });

  describe('setSettings', () => {
    it('on the FIRST write (no currentVersion) sends If-Match "0" and omits expectedVersion from the body', async () => {
      const updated: DnaSettings = { doctorToggle: true, tenantEnabled: true, effective: true, version: 1 };
      mockPutWithIfMatch.mockResolvedValue(updated);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.setSettings({ enabled: true });
      });

      expect(mockPutWithIfMatch).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.SETTINGS, { enabled: true }, '"0"');
      expect(resp).toEqual(updated);
      expect(result.current.settings).toEqual(updated);
    });

    it('once a row exists, includes expectedVersion in the body AND If-Match', async () => {
      const updated: DnaSettings = { doctorToggle: false, tenantEnabled: true, effective: false, version: 4 };
      mockPutWithIfMatch.mockResolvedValue(updated);
      const { result } = renderHook(() => useDnaReport());

      await act(async () => {
        await result.current.setSettings({ enabled: false }, 3);
      });

      expect(mockPutWithIfMatch).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.SETTINGS, { enabled: false, expectedVersion: 3 }, '"3"');
    });
  });

  describe('generate', () => {
    it('POSTs GENERATE with the input and seeds job as queued', async () => {
      const jobResponse: DnaGenerateJobResponse = { jobId: 'job-1', status: 'PENDING' };
      mockPost.mockResolvedValue(jobResponse);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.generate({ promptTemplateId: 'tmpl-1' });
      });

      expect(mockPost).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.GENERATE, { promptTemplateId: 'tmpl-1' });
      expect(resp).toEqual(jobResponse);
      expect(result.current.job).toEqual({ jobId: 'job-1', status: 'queued' });
    });

    it('defaults to an empty body when no input is supplied', async () => {
      mockPost.mockResolvedValue({ jobId: 'job-2', status: 'PENDING' });
      const { result } = renderHook(() => useDnaReport());

      await act(async () => {
        await result.current.generate();
      });

      expect(mockPost).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.GENERATE, {});
    });
  });

  describe('getJobStatus', () => {
    it('GETs JOB(jobId) and stores the snapshot', async () => {
      const status: DnaJobStatus = { jobId: 'job-1', status: 'processing', progress: 40 };
      mockGet.mockResolvedValue(status);
      const { result } = renderHook(() => useDnaReport());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getJobStatus('job-1');
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.JOB('job-1'));
      expect(resp).toEqual(status);
      expect(result.current.job).toEqual(status);
    });
  });

  describe('pollJobStatus', () => {
    it('polls until a terminal status and resolves with it', async () => {
      mockGet
        .mockResolvedValueOnce({ jobId: 'job-1', status: 'processing', progress: 20 })
        .mockResolvedValueOnce({ jobId: 'job-1', status: 'processing', progress: 60 })
        .mockResolvedValueOnce({ jobId: 'job-1', status: 'completed', progress: 100, result: { reportId: 'report-1' } });
      const { result } = renderHook(() => useDnaReport());

      let pollPromise!: Promise<DnaJobStatus>;
      act(() => {
        pollPromise = result.current.pollJobStatus('job-1', { intervalMs: 1000 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      const final = await pollPromise;
      expect(final.status).toBe('completed');
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(result.current.job?.status).toBe('completed');
    });

    it('rejects once timeoutMs elapses without a terminal status', async () => {
      mockGet.mockResolvedValue({ jobId: 'job-1', status: 'processing', progress: 10 });
      const { result } = renderHook(() => useDnaReport());

      let pollPromise!: Promise<DnaJobStatus>;
      act(() => {
        pollPromise = result.current.pollJobStatus('job-1', { intervalMs: 1000, timeoutMs: 1500 });
      });

      const assertion = expect(pollPromise).rejects.toThrow(/exceeded timeout/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await assertion;
    });
  });
});
