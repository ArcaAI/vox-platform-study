/**
 * useAdminTranscriptionJobs Hook Tests
 *
 * Tenant-wide transcription-job supervision for TENANT_ADMIN / GLOBAL_ADMIN.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAdminTranscriptionJobs } from '../useAdminTranscriptionJobs';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { ADMIN_TRANSCRIPTION_JOB_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAdminTranscriptionJobs', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockStore = { apiClient: { get: mockGet }, logger: mockLogger };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('returns empty jobs', () => {
            const { result } = renderHook(() => useAdminTranscriptionJobs());
            expect(result.current.jobs).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('GETs ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST and returns paginated (total, not count)', async () => {
            const data = [{ id: 'j-1', status: 'COMPLETED' }];
            mockGet.mockResolvedValue({ data, count: 1, page: 1, limit: 20 });
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            let resp: any;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST);
            expect(resp.data).toEqual(data);
            expect(resp.total).toBe(1);
            expect(result.current.jobs).toEqual(data);
        });

        it('passes page/limit pagination params', async () => {
            mockGet.mockResolvedValue({ data: [], total: 0 });
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            await act(async () => { await result.current.list({ page: 3, limit: 50 }); });

            expect(mockGet).toHaveBeenCalledWith(`${ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST}?page=3&limit=50`);
        });

        it('surfaces a server 403 as a clean AgenticError(FORBIDDEN)', async () => {
            mockGet.mockRejectedValue(new AgenticError('FORBIDDEN', 'Forbidden'));
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            let caught: unknown;
            await act(async () => {
                try { await result.current.list(); } catch (e) { caught = e; }
            });

            expect(caught).toBeInstanceOf(AgenticError);
            expect((caught as AgenticError).code).toBe('FORBIDDEN');
        });
    });

    describe('stats', () => {
        it('GETs ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.STATS', async () => {
            const counts = { COMPLETED: 5, FAILED: 1 };
            mockGet.mockResolvedValue(counts);
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            let resp: any;
            await act(async () => { resp = await result.current.stats(); });

            expect(mockGet).toHaveBeenCalledWith(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.STATS);
            expect(resp).toEqual(counts);
        });
    });

    describe('byStatus', () => {
        it('GETs ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.BY_STATUS(status) and returns an array', async () => {
            const jobs = [{ id: 'j-1', status: 'FAILED' }];
            mockGet.mockResolvedValue(jobs);
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            let resp: any;
            await act(async () => { resp = await result.current.byStatus('FAILED'); });

            expect(mockGet).toHaveBeenCalledWith(ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.BY_STATUS('FAILED'));
            expect(resp).toEqual(jobs);
        });
    });

    describe('SDK not initialized', () => {
        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useAdminTranscriptionJobs());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
