/**
 * useDnaStyle Hook Tests (SDK-207 WS-5)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaStyle } from '../useDnaStyle';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { DNA_STYLE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return {
        ...actual,
        useAgenticStore: vi.fn(),
    };
});

describe('useDnaStyle', () => {
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

    describe('initial state', () => {
        it('should return null style and empty versions', () => {
            const { result } = renderHook(() => useDnaStyle());
            expect(result.current.style).toBeNull();
            expect(result.current.versions).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('getMyStyle', () => {
        it('should fetch from DNA_STYLE_ENDPOINTS.MY_STYLE and update state', async () => {
            const report = { id: 'dna-1', doctorId: 'd-1', reportData: {}, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValue(report);
            const { result } = renderHook(() => useDnaStyle());

            let returnedReport: unknown;
            await act(async () => {
                returnedReport = await result.current.getMyStyle();
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.MY_STYLE);
            expect(result.current.style).toEqual(report);
            expect(returnedReport).toEqual(report);
            expect(result.current.isLoading).toBe(false);
        });

        it('should set error on failure', async () => {
            const error = new Error('Network error');
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getMyStyle(); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.getMyStyle(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('generate', () => {
        it('should POST to DNA_STYLE_ENDPOINTS.GENERATE', async () => {
            const jobResp = { jobId: 'job-1' };
            mockPost.mockResolvedValue(jobResp);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.generate({ departmentId: 'dept-1' });
            });

            // Body carries departmentId + auto-attached idempotencyKey.
            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(DNA_STYLE_ENDPOINTS.GENERATE);
            expect(body).toMatchObject({ departmentId: 'dept-1' });
            expect(typeof body.idempotencyKey).toBe('string');
            expect(resp).toEqual(jobResp);
        });

        it('should POST with idempotencyKey-only body when no input', async () => {
            mockPost.mockResolvedValue({ jobId: 'job-2' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.generate();
            });

            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(DNA_STYLE_ENDPOINTS.GENERATE);
            expect(typeof body.idempotencyKey).toBe('string');
        });

        it('should set error on failure and reset isLoading to false', async () => {
            const error = new Error('Generate failed');
            mockPost.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.generate(); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.generate(); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should not update style state (generate returns jobId, not DnaReport)', async () => {
            mockPost.mockResolvedValue({ jobId: 'job-3' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.generate({ departmentId: 'dept-1' });
            });

            expect(result.current.style).toBeNull();
        });
    });

    describe('update', () => {
        it('should PATCH to DNA_STYLE_ENDPOINTS.UPDATE', async () => {
            const updated = { id: 'dna-1', doctorId: 'd-1', reportData: {}, styleText: 'new', isLatest: true, currentVersionNumber: 2, createdAt: '', updatedAt: '' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('dna-1', { styleText: 'new', changeReason: 'Manual edit' });
            });

            expect(mockPatch).toHaveBeenCalledWith(
                DNA_STYLE_ENDPOINTS.UPDATE('dna-1'),
                { styleText: 'new', changeReason: 'Manual edit' }
            );
            expect(result.current.style).toEqual(updated);
            expect(resp).toEqual(updated);
        });

        it('should set error on failure and reset isLoading to false', async () => {
            const error = new Error('Update failed');
            mockPatch.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.update('dna-1', { styleText: 'new', changeReason: 'Edit' }); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.update('dna-1', { styleText: 'new', changeReason: 'Edit' }); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('getVersions', () => {
        it('should GET from DNA_STYLE_ENDPOINTS.VERSIONS', async () => {
            const versions = [
                { id: 'v-1', dnaReportId: 'dna-1', versionNumber: 1, reportData: {}, createdAt: '' },
                { id: 'v-2', dnaReportId: 'dna-1', versionNumber: 2, reportData: {}, createdAt: '' },
            ];
            mockGet.mockResolvedValue(versions);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getVersions('dna-1');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.VERSIONS('dna-1'));
            expect(result.current.versions).toEqual(versions);
            expect(resp).toEqual(versions);
        });

        it('should set error on failure and reset isLoading to false', async () => {
            const error = new Error('Get versions failed');
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getVersions('dna-1'); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
            expect(result.current.isLoading).toBe(false);
        });

        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'v-1', dnaReportId: 'dna-1', versionNumber: 1, reportData: {}, createdAt: '' }];
            mockGet.mockResolvedValue({ data: items, count: 1 });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getVersions('dna-1'); });

            expect(result.current.versions).toEqual(items);
            expect(Array.isArray(result.current.versions)).toBe(true);
        });

        it('should return empty array for unexpected getVersions response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => { await result.current.getVersions('dna-1'); });

            expect(result.current.versions).toEqual([]);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.getVersions('dna-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear error on success after previous failure', async () => {
            const error = new Error('First call failed');
            const report = { id: 'dna-1', doctorId: 'd-1', reportData: {}, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockGet.mockRejectedValueOnce(error).mockResolvedValueOnce(report);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getMyStyle(); } catch { /* expected */ }
            });
            expect(result.current.error).toEqual(error);

            await act(async () => {
                await result.current.getMyStyle();
            });
            expect(result.current.error).toBeNull();
            expect(result.current.style).toEqual(report);
        });
    });

    describe('null logger', () => {
        it('should work when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const report = { id: 'dna-1', doctorId: 'd-1', reportData: {}, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValue(report);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.getMyStyle();
            });
            expect(result.current.style).toEqual(report);

            mockPost.mockResolvedValue({ jobId: 'job-1' });
            await act(async () => {
                await result.current.generate({ departmentId: 'dept-1' });
            });
            // Body adds idempotencyKey alongside departmentId.
            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(DNA_STYLE_ENDPOINTS.GENERATE);
            expect(body).toMatchObject({ departmentId: 'dept-1' });
            expect(typeof body.idempotencyKey).toBe('string');

            mockPatch.mockResolvedValue(report);
            await act(async () => {
                await result.current.update('dna-1', { styleText: 'new', changeReason: 'Edit' });
            });
            expect(result.current.style).toEqual(report);

            const versions = [{ id: 'v-1', dnaReportId: 'dna-1', versionNumber: 1, reportData: {}, createdAt: '' }];
            mockGet.mockResolvedValue(versions);
            await act(async () => {
                await result.current.getVersions('dna-1');
            });
            expect(result.current.versions).toEqual(versions);
        });
    });

    describe('sequential calls', () => {
        it('should update style to latest response when getMyStyle called twice', async () => {
            const report1 = { id: 'dna-1', doctorId: 'd-1', reportData: { v: 1 }, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            const report2 = { id: 'dna-1', doctorId: 'd-1', reportData: { v: 2 }, isLatest: true, currentVersionNumber: 2, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValueOnce(report1).mockResolvedValueOnce(report2);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.getMyStyle();
            });
            expect(result.current.style).toEqual(report1);

            await act(async () => {
                await result.current.getMyStyle();
            });
            expect(result.current.style).toEqual(report2);
        });
    });

    describe('pollJobStatus timer cancellation on unmount', () => {
        it('should stop polling when component unmounts', async () => {
            vi.useFakeTimers();
            let callCount = 0;
            mockGet.mockImplementation(async () => {
                callCount++;
                return { status: 'processing' };
            });

            const { result, unmount } = renderHook(() => useDnaStyle());

            let pollPromise: Promise<any>;
            act(() => {
                pollPromise = result.current.pollJobStatus('job-1', { intervalMs: 100, maxAttempts: 50 });
            });

            // Let 2 poll cycles run
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            const callsBeforeUnmount = callCount;

            // Unmount the component
            unmount();

            // Advance timers significantly — no more calls should happen
            await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
            expect(callCount).toBe(callsBeforeUnmount);

            vi.useRealTimers();
        });
    });
});
