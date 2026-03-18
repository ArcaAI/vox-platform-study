/**
 * useDnaStyle Hook Tests — New Methods (TASK-032 WS-H)
 *
 * Tests for getJobStatus, pollJobStatus, getByDoctor.
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
        fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(),
        debug: vi.fn(), trace: vi.fn(), http: vi.fn(),
        child: vi.fn().mockReturnThis(),
        withMeta: vi.fn().mockReturnThis(),
        withCorrelation: vi.fn().mockReturnThis(),
        withUser: vi.fn().mockReturnThis(),
        setCorrelationId: vi.fn(),
        getCorrelationId: vi.fn().mockReturnValue('mock-correlation-id'),
        generateCorrelationId: vi.fn().mockReturnValue('generated-correlation-id'),
        startOperation: vi.fn().mockReturnValue({
            name: 'mock-operation', startTime: Date.now(),
            end: vi.fn(), error: vi.fn(),
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
    reportData: {
        formality: 'formal',
        sentenceLength: 'medium',
        medicalTermUsage: 'high',
        abbreviationStyle: 'standard',
        avgSentenceLength: 18.5,
        vocabularyComplexity: 0.72,
        formalityLevel: 0.85,
        commonPhrases: ['patient presents with'],
        abbreviations: ['Hx', 'Dx'],
        sectionOrder: ['HPI', 'Assessment', 'Plan'],
    },
    styleText: 'Formal medical writing with moderate sentence length.',
    isLatest: true,
    currentVersionNumber: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useDnaStyle — new methods', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: vi.fn() },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    // ─── getJobStatus ──────────────────────────────────────────

    describe('getJobStatus', () => {
        it('should GET from DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS', async () => {
            const jobStatus = { status: 'processing' };
            mockGet.mockResolvedValue(jobStatus);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getJobStatus('job-1');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.JOB_STATUS('job-1'));
            expect(resp).toEqual(jobStatus);
        });

        it('should update style when result is present in response', async () => {
            const jobStatus = { status: 'completed', result: mockReport };
            mockGet.mockResolvedValue(jobStatus);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.getJobStatus('job-1');
            });

            expect(result.current.style).toEqual(mockReport);
        });

        it('should NOT update style when result is absent', async () => {
            mockGet.mockResolvedValue({ status: 'processing' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.getJobStatus('job-1');
            });

            expect(result.current.style).toBeNull();
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Job not found'));
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getJobStatus('job-bad'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Job not found');
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.getJobStatus('job-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    // ─── pollJobStatus ─────────────────────────────────────────

    describe('pollJobStatus', () => {
        it('should resolve immediately when first poll returns completed', async () => {
            mockGet.mockResolvedValueOnce({ status: 'completed', result: mockReport });
            const { result } = renderHook(() => useDnaStyle());

            let resolved: unknown;
            await act(async () => {
                resolved = await result.current.pollJobStatus('job-1', { intervalMs: 10, maxAttempts: 5 });
            });

            expect(resolved).toEqual(mockReport);
            expect(result.current.style).toEqual(mockReport);
            expect(mockGet).toHaveBeenCalledTimes(1);
        });

        it('should reject when status becomes failed', async () => {
            mockGet.mockResolvedValue({ status: 'failed' });
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => {
                    await result.current.pollJobStatus('job-fail', { intervalMs: 10, maxAttempts: 5 });
                })
            ).rejects.toThrow('DNA report generation failed');
        });

        it('should reject on API error during polling', async () => {
            mockGet.mockRejectedValue(new Error('Network error'));
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => {
                    await result.current.pollJobStatus('job-err', { intervalMs: 10, maxAttempts: 5 });
                })
            ).rejects.toThrow('Network error');
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.pollJobStatus('job-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    // ─── getByDoctor ───────────────────────────────────────────

    describe('getByDoctor', () => {
        it('should GET from DNA_STYLE_ENDPOINTS.BY_DOCTOR and update style', async () => {
            mockGet.mockResolvedValue(mockReport);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getByDoctor('doc-1');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.BY_DOCTOR('doc-1'));
            expect(result.current.style).toEqual(mockReport);
            expect(resp).toEqual(mockReport);
        });

        it('should set error on failure and reset isLoading', async () => {
            mockGet.mockRejectedValue(new Error('Doctor not found'));
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getByDoctor('doc-bad'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Doctor not found');
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.getByDoctor('doc-1'); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('First failed')).mockResolvedValueOnce(mockReport);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getByDoctor('doc-1'); } catch { /* expected */ }
            });
            expect(result.current.error).not.toBeNull();

            await act(async () => {
                await result.current.getByDoctor('doc-1');
            });
            expect(result.current.error).toBeNull();
            expect(result.current.style).toEqual(mockReport);
        });
    });

    // ─── isLoading state transitions ──────────────────────────

    describe('isLoading state transitions', () => {
        it('getJobStatus should reset isLoading on success', async () => {
            mockGet.mockResolvedValue({ status: 'processing' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getJobStatus('job-1'); });
            expect(result.current.isLoading).toBe(false);
        });

        it('getJobStatus should reset isLoading on failure', async () => {
            mockGet.mockRejectedValue(new Error('fail'));
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getJobStatus('job-1'); } catch { /* expected */ }
            });
            expect(result.current.isLoading).toBe(false);
        });

        it('getByDoctor should reset isLoading on success', async () => {
            mockGet.mockResolvedValue(mockReport);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getByDoctor('doc-1'); });
            expect(result.current.isLoading).toBe(false);
        });
    });

    // ─── error clearing ───────────────────────────────────────

    describe('error clearing', () => {
        it('getJobStatus should clear previous error on new call', async () => {
            mockGet.mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce({ status: 'processing' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getJobStatus('job-1'); } catch { /* expected */ }
            });
            expect(result.current.error).not.toBeNull();

            await act(async () => { await result.current.getJobStatus('job-1'); });
            expect(result.current.error).toBeNull();
        });
    });

    // ─── null logger ───────────────────────────────────────────

    describe('null logger', () => {
        it('should work for all new methods when logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            mockGet.mockResolvedValueOnce({ status: 'completed', result: mockReport });
            await act(async () => { await result.current.getJobStatus('job-1'); });
            expect(result.current.style).toEqual(mockReport);

            mockGet.mockResolvedValueOnce(mockReport);
            await act(async () => { await result.current.getByDoctor('doc-1'); });
            expect(result.current.style).toEqual(mockReport);
        });
    });

    // ─── reportData field access ──────────────────────────────

    describe('reportData structural completeness', () => {
        it('should preserve all DnaReportData fields through getByDoctor', async () => {
            mockGet.mockResolvedValue(mockReport);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getByDoctor('doc-1'); });

            const style = result.current.style!;
            expect(style.reportData.formality).toBe('formal');
            expect(style.reportData.avgSentenceLength).toBe(18.5);
            expect(style.reportData.commonPhrases).toContain('patient presents with');
            expect(style.styleText).toBe('Formal medical writing with moderate sentence length.');
            expect(style.departmentId).toBe('dept-1');
        });

        it('should preserve all DnaReportData fields through getJobStatus', async () => {
            mockGet.mockResolvedValue({ status: 'completed', result: mockReport });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getJobStatus('job-1'); });

            const style = result.current.style!;
            expect(style.reportData.vocabularyComplexity).toBe(0.72);
            expect(style.reportData.abbreviations).toEqual(['Hx', 'Dx']);
            expect(style.reportData.sectionOrder).toEqual(['HPI', 'Assessment', 'Plan']);
        });
    });

    // ─── pollJobStatus edge cases (uses fake timers, must be last) ──

    describe('pollJobStatus — edge cases', () => {
        beforeEach(() => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should not resolve when completed but result is undefined, eventually fail', async () => {
            let callCount = 0;
            mockGet.mockImplementation(async () => {
                callCount++;
                if (callCount >= 3) return { status: 'failed' };
                return { status: 'completed' };
            });
            const { result } = renderHook(() => useDnaStyle());

            let caughtError: Error | null = null;
            const pollPromise = act(async () => {
                try {
                    await result.current.pollJobStatus('job-no-result', { intervalMs: 50, maxAttempts: 5 });
                } catch (err) {
                    caughtError = err as Error;
                }
            });

            await vi.advanceTimersByTimeAsync(500);
            await pollPromise;
            expect(caughtError).not.toBeNull();
            expect(caughtError!.message).toBe('DNA report generation failed');
            expect(callCount).toBe(3);
        });

        it('should poll through processing states then resolve on completed', async () => {
            mockGet
                .mockResolvedValueOnce({ status: 'processing' })
                .mockResolvedValueOnce({ status: 'processing' })
                .mockResolvedValueOnce({ status: 'completed', result: mockReport });
            const { result } = renderHook(() => useDnaStyle());

            const pollPromise = act(async () => {
                return await result.current.pollJobStatus('job-slow', { intervalMs: 50, maxAttempts: 5 });
            });

            await vi.advanceTimersByTimeAsync(500);
            const resolved = await pollPromise;
            expect(resolved).toEqual(mockReport);
            expect(mockGet).toHaveBeenCalledTimes(3);
        });
    });
});
