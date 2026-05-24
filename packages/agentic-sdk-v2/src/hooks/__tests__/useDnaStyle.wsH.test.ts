/**
 * useDnaStyle Hook Tests — Workstream H Enhancements
 *
 * Tests for: getJobStatus, pollJobStatus, getByDoctor, promptTemplateId in generate
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

describe('useDnaStyle — WS-H enhancements', () => {
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

    // ─── H-2: getJobStatus ──────────────────────────────────────

    describe('getJobStatus (H-2)', () => {
        it('should GET from DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS', async () => {
            const jobStatus = { jobId: 'job-1', status: 'active', progress: 50 };
            mockGet.mockResolvedValue(jobStatus);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getJobStatus('job-1');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.JOB_STATUS('job-1'));
            expect(resp).toEqual(jobStatus);
        });

        it('should set error on failure', async () => {
            const error = new Error('Job not found');
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getJobStatus('bad-id'); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
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

    // ─── H-2: pollJobStatus ─────────────────────────────────────

    describe('pollJobStatus (H-2)', () => {
        it('should poll until completed and return updated style', async () => {
            const report = { id: 'dna-1', doctorId: 'd-1', reportData: {}, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };

            mockGet
                .mockResolvedValueOnce({ status: 'completed', result: { reportId: report.id } })
                .mockResolvedValueOnce(report);

            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.pollJobStatus('job-1', { intervalMs: 10, maxAttempts: 5 });
            });

            expect(resp).toEqual(report);
            expect(result.current.style).toEqual(report);
            expect(mockGet).toHaveBeenNthCalledWith(1, DNA_STYLE_ENDPOINTS.JOB_STATUS('job-1'));
            expect(mockGet).toHaveBeenNthCalledWith(2, DNA_STYLE_ENDPOINTS.MY_STYLE);
        });

        it('should throw when job fails', async () => {
            const failedStatus = { jobId: 'job-1', status: 'failed' };
            mockGet.mockResolvedValue(failedStatus);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try {
                    await result.current.pollJobStatus('job-1', { intervalMs: 10, maxAttempts: 3 });
                } catch (err: any) {
                    expect(err.message).toContain('failed');
                }
            });
        });

        it('should throw when max attempts exceeded', async () => {
            mockGet.mockResolvedValue({ status: 'processing' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try {
                    await result.current.pollJobStatus('job-1', { intervalMs: 10, maxAttempts: 1 });
                } catch (err: any) {
                    expect(err.message).toContain('Polling exceeded max attempts');
                }
            });
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

    // ─── H-3: promptTemplateId in generate ──────────────────────

    describe('generate with promptTemplateId (H-3)', () => {
        it('should POST with promptTemplateId when provided', async () => {
            mockPost.mockResolvedValue({ jobId: 'job-1' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                const input = { departmentId: 'dept-1', promptTemplateId: 'prompt-tmpl-1' };
                await result.current.generate(input);
            });

            expect(mockPost).toHaveBeenCalledWith(
                DNA_STYLE_ENDPOINTS.GENERATE,
                { departmentId: 'dept-1', promptTemplateId: 'prompt-tmpl-1' }
            );
        });

        it('should POST without promptTemplateId when not provided', async () => {
            mockPost.mockResolvedValue({ jobId: 'job-2' });
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                await result.current.generate({ departmentId: 'dept-1' });
            });

            expect(mockPost).toHaveBeenCalledWith(
                DNA_STYLE_ENDPOINTS.GENERATE,
                { departmentId: 'dept-1' }
            );
        });
    });

    // ─── H-4: getByDoctor ───────────────────────────────────────

    describe('getByDoctor (H-4)', () => {
        it('should GET from DNA_STYLE_ENDPOINTS.BY_DOCTOR', async () => {
            const report = { id: 'dna-1', doctorId: 'doc-1', reportData: {}, isLatest: true, currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValue(report);
            const { result } = renderHook(() => useDnaStyle());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getByDoctor('doc-1');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.BY_DOCTOR('doc-1'));
            expect(resp).toEqual(report);
        });

        it('should set error when doctor not found', async () => {
            const error = Object.assign(new Error('Not found'), { status: 404 });
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getByDoctor('doc-nonexistent'); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
        });

        it('should throw non-404 errors', async () => {
            const error = new Error('Server error');
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaStyle());

            await act(async () => {
                try { await result.current.getByDoctor('doc-1'); } catch { /* expected */ }
            });

            expect(result.current.error).toEqual(error);
        });

        it('should throw when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaStyle());

            await expect(
                act(async () => { await result.current.getByDoctor('doc-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
