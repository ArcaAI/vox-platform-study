/**
 * useDnaWritingStyle Hook Tests (TASK-974, lane L3)
 *
 * Mirrors the getJob/pollJob idioms of `useConsultationJob.test.ts` —
 * mocked `useAgenticStore` (context-backed, per-provider store), a mocked
 * `apiClient`, and fake timers for the polling loop.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaWritingStyle } from '../useDnaWritingStyle';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { DNA_WRITING_STYLE_ENDPOINTS } from '../../core/constants';
import type { DnaWritingSamplesIngestInput, DnaIngestJobResponse, DnaIngestJobStatus } from '../../types/dna';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const ingestInput: DnaWritingSamplesIngestInput = {
  items: [
    { text: 'Patient presents with mild cough.', writtenAt: '2026-09-01T10:00:00.000Z', kind: 'CASE_NOTE' },
    { text: 'Follow-up scheduled in two weeks.', writtenAt: '2026-09-05T10:00:00.000Z', kind: 'WORK_NOTE' },
  ],
};

const ingestResponse: DnaIngestJobResponse = {
  jobId: 'job-dna-1',
  status: 'PENDING',
  clinicianUserId: 'doctor-1',
  acceptedItems: 2,
  window: { from: '2026-09-01T10:00:00.000Z', to: '2026-09-05T10:00:00.000Z' },
};

describe('useDnaWritingStyle', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();

    mockStore = {
      apiClient: {
        get: mockGet,
        post: mockPost,
        patch: vi.fn(),
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
    it('should return null job, not ingesting, no error', () => {
      const { result } = renderHook(() => useDnaWritingStyle());
      expect(result.current.job).toBeNull();
      expect(result.current.isIngesting).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('ingest', () => {
    it('should POST to DNA_WRITING_STYLE_ENDPOINTS.INGEST with the input as the body', async () => {
      mockPost.mockResolvedValue(ingestResponse);
      const { result } = renderHook(() => useDnaWritingStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.ingest(ingestInput);
      });

      expect(mockPost).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.INGEST, ingestInput);
      expect(resp).toEqual(ingestResponse);
    });

    it('should set job to a queued status keyed on the returned jobId', async () => {
      mockPost.mockResolvedValue(ingestResponse);
      const { result } = renderHook(() => useDnaWritingStyle());

      await act(async () => {
        await result.current.ingest(ingestInput);
      });

      expect(result.current.job?.jobId).toBe('job-dna-1');
      expect(result.current.job?.status).toBe('queued');
    });

    it('should toggle isIngesting around the call', async () => {
      let resolvePost: (value: DnaIngestJobResponse) => void;
      mockPost.mockReturnValue(
        new Promise<DnaIngestJobResponse>((resolve) => {
          resolvePost = resolve;
        }),
      );
      const { result } = renderHook(() => useDnaWritingStyle());

      let ingestPromise!: Promise<DnaIngestJobResponse>;
      act(() => {
        ingestPromise = result.current.ingest(ingestInput);
      });
      expect(result.current.isIngesting).toBe(true);

      await act(async () => {
        resolvePost!(ingestResponse);
        await ingestPromise;
      });
      expect(result.current.isIngesting).toBe(false);
    });

    it('should set error on failure', async () => {
      mockPost.mockRejectedValue(new Error('DNA_INGEST_TOO_LARGE'));
      const { result } = renderHook(() => useDnaWritingStyle());

      await act(async () => {
        try {
          await result.current.ingest(ingestInput);
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('DNA_INGEST_TOO_LARGE');
      expect(result.current.isIngesting).toBe(false);
    });

    it('should throw when apiClient is not available', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useDnaWritingStyle());

      await expect(
        act(async () => {
          await result.current.ingest(ingestInput);
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('getIngestJob', () => {
    it('should GET from DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB and update state', async () => {
      const status: DnaIngestJobStatus = { jobId: 'job-dna-1', status: 'processing', progress: 40 };
      mockGet.mockResolvedValue(status);
      const { result } = renderHook(() => useDnaWritingStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getIngestJob('job-dna-1');
      });

      expect(mockGet).toHaveBeenCalledWith(DNA_WRITING_STYLE_ENDPOINTS.INGEST_JOB('job-dna-1'));
      expect(result.current.job).toEqual(status);
      expect(resp).toEqual(status);
    });

    it('should set error on failure', async () => {
      mockGet.mockRejectedValue(new Error('Not found'));
      const { result } = renderHook(() => useDnaWritingStyle());

      await act(async () => {
        try {
          await result.current.getIngestJob('job-bad');
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Not found');
    });

    it('should throw when apiClient is not available', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useDnaWritingStyle());

      await expect(
        act(async () => {
          await result.current.getIngestJob('job-dna-1');
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('pollIngestJob', () => {
    it('should resolve when the job reaches completed', async () => {
      const processing: DnaIngestJobStatus = { jobId: 'job-dna-1', status: 'processing', progress: 50 };
      const completed: DnaIngestJobStatus = { jobId: 'job-dna-1', status: 'completed', progress: 100, result: { reportId: 'report-1' } };
      mockGet.mockResolvedValueOnce(processing).mockResolvedValueOnce(completed);

      const { result } = renderHook(() => useDnaWritingStyle());

      let pollPromise!: Promise<DnaIngestJobStatus>;
      act(() => {
        pollPromise = result.current.pollIngestJob('job-dna-1', { intervalMs: 1000 });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      const resolved = await pollPromise;
      expect(resolved).toEqual(completed);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('should resolve when the job reaches failed', async () => {
      const failed: DnaIngestJobStatus = { jobId: 'job-dna-2', status: 'failed', error: 'DNA_ANALYST_AGENT_UNAVAILABLE' };
      mockGet.mockResolvedValueOnce(failed);

      const { result } = renderHook(() => useDnaWritingStyle());

      let pollPromise!: Promise<DnaIngestJobStatus>;
      act(() => {
        pollPromise = result.current.pollIngestJob('job-dna-2');
      });

      const resolved = await pollPromise;
      expect(resolved).toEqual(failed);
    });

    it('should reject once the poll exceeds timeoutMs', async () => {
      const queued: DnaIngestJobStatus = { jobId: 'job-dna-3', status: 'queued' };
      mockGet.mockResolvedValue(queued);

      const { result } = renderHook(() => useDnaWritingStyle());

      let pollPromise!: Promise<DnaIngestJobStatus>;
      act(() => {
        pollPromise = result.current.pollIngestJob('job-dna-3', { intervalMs: 1000, timeoutMs: 2500 });
      });

      const assertion = expect(pollPromise).rejects.toThrow(/timeout/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      await assertion;
    });

    it('should throw when apiClient is not available', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useDnaWritingStyle());

      await expect(
        act(async () => {
          await result.current.pollIngestJob('job-dna-1');
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });
});
