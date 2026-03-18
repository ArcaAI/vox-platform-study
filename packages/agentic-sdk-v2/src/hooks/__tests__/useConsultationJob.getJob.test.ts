/**
 * useConsultationJob — getJob and pollJob Tests (TASK-032)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConsultationJob } from '../useConsultationJob';
import { useAgenticStore } from '../../store/agenticStore';
import { CONSULTATION_JOB_ENDPOINTS } from '../../core/constants';

function createMockLogger() {
    return {
        fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(),
        debug: vi.fn(), trace: vi.fn(), http: vi.fn(),
        child: vi.fn().mockReturnThis(),
        startOperation: vi.fn().mockReturnValue({
            name: 'mock-op', startTime: Date.now(), end: vi.fn(), error: vi.fn(),
        }),
    };
}

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

const mockJob = {
    id: 'job-1',
    status: 'completed',
    progress: 100,
    consultationId: 'cons-1',
    currentStep: 'finalize',
    result: { transcript: 'Patient presents with...' },
    error: undefined,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
};

describe('useConsultationJob — getJob', () => {
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockGet.mockReset();
        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
            logger: createMockLogger(),
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('should GET from CONSULTATION_JOB_ENDPOINTS.GET and update state', async () => {
        mockGet.mockResolvedValue(mockJob);
        const { result } = renderHook(() => useConsultationJob());

        let resp: unknown;
        await act(async () => {
            resp = await result.current.getJob('job-1');
        });

        expect(mockGet).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.GET('job-1'));
        expect(result.current.job).toEqual(mockJob);
        expect(resp).toEqual(mockJob);
    });

    it('should update status from job response', async () => {
        mockGet.mockResolvedValue({ ...mockJob, status: 'processing' });
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            await result.current.getJob('job-1');
        });

        expect(result.current.status).toBe('processing');
    });

    it('should set error on failure', async () => {
        mockGet.mockRejectedValue(new Error('Not found'));
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            try { await result.current.getJob('job-bad'); } catch { /* expected */ }
        });

        expect(result.current.error?.message).toBe('Not found');
    });

    it('should throw when apiClient is not available', async () => {
        mockStore.apiClient = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useConsultationJob());

        await expect(
            act(async () => { await result.current.getJob('job-1'); })
        ).rejects.toThrow('SDK not initialized');
    });

    describe('initial state', () => {
        it('should have null job, idle status, not streaming, no error', () => {
            const { result } = renderHook(() => useConsultationJob());
            expect(result.current.job).toBeNull();
            expect(result.current.status).toBe('idle');
            expect(result.current.isStreaming).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on successful getJob', async () => {
            mockGet.mockRejectedValueOnce(new Error('First call failed'));
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                try { await result.current.getJob('job-bad'); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('First call failed');

            mockGet.mockResolvedValueOnce(mockJob);
            await act(async () => {
                await result.current.getJob('job-1');
            });
            expect(result.current.error).toBeNull();
            expect(result.current.job).toEqual(mockJob);
        });
    });

    describe('response field completeness', () => {
        it('should preserve all ConsultationJob fields in state', async () => {
            mockGet.mockResolvedValue(mockJob);
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => { await result.current.getJob('job-1'); });

            const job = result.current.job!;
            expect(job.id).toBe('job-1');
            expect(job.consultationId).toBe('cons-1');
            expect(job.progress).toBe(100);
            expect(job.currentStep).toBe('finalize');
            expect(job.result).toEqual({ transcript: 'Patient presents with...' });
            expect(job.startedAt).toBe('2026-01-01T00:00:00.000Z');
            expect(job.completedAt).toBe('2026-01-01T00:05:00.000Z');
        });

        it('should handle job with optional fields missing', async () => {
            const minimalJob = { id: 'job-2', status: 'pending', consultationId: 'cons-2' };
            mockGet.mockResolvedValue(minimalJob);
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => { await result.current.getJob('job-2'); });

            expect(result.current.job!.progress).toBeUndefined();
            expect(result.current.job!.result).toBeUndefined();
            expect(result.current.job!.error).toBeUndefined();
            expect(result.current.status).toBe('pending');
        });
    });
});
