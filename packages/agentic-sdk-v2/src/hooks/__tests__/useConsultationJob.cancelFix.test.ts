/**
 * useConsultationJob — cancelJob HTTP Method Fix Test
 *
 * Verifies cancelJob uses PATCH instead of DELETE.
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

describe('useConsultationJob — cancelJob fix', () => {
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        const mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), patch: mockPatch, delete: mockDelete },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('should call apiClient.patch (NOT delete) for cancelJob', async () => {
        mockPatch.mockResolvedValue(undefined);
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            await result.current.cancelJob('job-123');
        });

        expect(mockPatch).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.CANCEL('job-123'), {});
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('should set status to cancelled on success', async () => {
        mockPatch.mockResolvedValue(undefined);
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            await result.current.cancelJob('job-123');
        });

        expect(result.current.status).toBe('cancelled');
    });

    it('should set error on failure', async () => {
        mockPatch.mockRejectedValue(new Error('Cancel failed'));
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            try { await result.current.cancelJob('job-123'); } catch { /* expected */ }
        });

        expect(result.current.error?.message).toBe('Cancel failed');
    });

    it('should throw when apiClient is not available', async () => {
        mockStore.apiClient = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useConsultationJob());

        await expect(
            act(async () => { await result.current.cancelJob('job-123'); })
        ).rejects.toThrow('SDK not initialized');
    });

    it('should clear previous error before calling cancel', async () => {
        mockPatch.mockRejectedValueOnce(new Error('First cancel failed'));
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            try { await result.current.cancelJob('job-123'); } catch { /* expected */ }
        });
        expect(result.current.error?.message).toBe('First cancel failed');

        mockPatch.mockResolvedValueOnce(undefined);
        await act(async () => {
            await result.current.cancelJob('job-123');
        });
        expect(result.current.error).toBeNull();
        expect(result.current.status).toBe('cancelled');
    });

    it('should use endpoint constant for path construction, not hardcoded strings', async () => {
        mockPatch.mockResolvedValue(undefined);
        const { result } = renderHook(() => useConsultationJob());

        await act(async () => {
            await result.current.cancelJob('abc-def-ghi');
        });

        expect(mockPatch).toHaveBeenCalledWith(
            CONSULTATION_JOB_ENDPOINTS.CANCEL('abc-def-ghi'),
            {}
        );
    });
});
