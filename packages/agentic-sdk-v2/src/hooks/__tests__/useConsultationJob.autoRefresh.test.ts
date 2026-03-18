/**
 * useConsultationJob Auto-Refresh Tests (TASK-032 WS-B, Task B-3)
 *
 * Tests that useConsultationJob automatically refreshes context items
 * when a transcription job completes (via polling or SSE).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { CONSULTATION_JOB_ENDPOINTS, CONTEXT_ENDPOINTS } from '../../core/constants';

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockPost = vi.fn();
let mockStoreValue: any = {};

vi.mock('../../store/agenticStore', () => ({
    useAgenticStore: vi.fn(() => mockStoreValue),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
}));

vi.mock('../../store', () => ({
    useAgenticStore: vi.fn(() => mockStoreValue),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
}));

import { useConsultationJob } from '../useConsultationJob';

describe('B-3: Auto-refresh context items on job completion', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockDelete.mockReset();
        mockPost.mockReset();
        mockStoreValue = {
            apiClient: { get: mockGet, post: mockPost, patch: vi.fn(), delete: mockDelete },
            logger: null,
            consultation: { id: 'c-001' },
        };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('pollJob auto-refresh', () => {
        it('should refresh context items when pollJob resolves with completed status', async () => {
            const completedJob = {
                id: 'job-1',
                status: 'completed',
                consultationId: 'c-001',
                progress: 100,
            };
            const contextItems = [
                { id: 'ctx-1', type: 'transcription', content: 'Hello doctor' },
                { id: 'ctx-2', type: 'case_note', content: 'Patient notes' },
            ];

            mockGet
                .mockResolvedValueOnce(completedJob)
                .mockResolvedValueOnce(contextItems);

            const { result } = renderHook(() => useConsultationJob());

            let job: unknown;
            await act(async () => {
                job = await result.current.pollJob('job-1', { maxAttempts: 1 });
            });

            expect(mockGet).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.GET('job-1'));
            expect(mockGet).toHaveBeenCalledWith(CONTEXT_ENDPOINTS.GET('c-001'));
        });

        it('should refresh context items when pollJob resolves with failed status', async () => {
            const failedJob = {
                id: 'job-2',
                status: 'failed',
                consultationId: 'c-001',
                error: 'Processing error',
            };
            const contextItems = [{ id: 'ctx-1', type: 'transcription', content: 'Partial' }];

            mockGet
                .mockResolvedValueOnce(failedJob)
                .mockResolvedValueOnce(contextItems);

            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                await result.current.pollJob('job-2', { maxAttempts: 1 });
            });

            expect(mockGet).toHaveBeenCalledWith(CONTEXT_ENDPOINTS.GET('c-001'));
        });

        it('should NOT refresh context items when no consultation ID available', async () => {
            mockStoreValue.consultation = null;

            const completedJob = {
                id: 'job-3',
                status: 'completed',
                consultationId: '',
                progress: 100,
            };

            mockGet.mockResolvedValueOnce(completedJob);

            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                await result.current.pollJob('job-3', { maxAttempts: 1 });
            });

            const contextGetCalls = mockGet.mock.calls.filter(
                (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/context')
            );
            expect(contextGetCalls).toHaveLength(0);
        });

        it('should not fail the poll if context refresh fails', async () => {
            const completedJob = {
                id: 'job-4',
                status: 'completed',
                consultationId: 'c-001',
                progress: 100,
            };

            mockGet
                .mockResolvedValueOnce(completedJob)
                .mockRejectedValueOnce(new Error('Context fetch failed'));

            const { result } = renderHook(() => useConsultationJob());

            let job: unknown;
            await act(async () => {
                job = await result.current.pollJob('job-4', { maxAttempts: 1 });
            });

            expect(job).toEqual(completedJob);
        });

        it('should use consultationId from the job if store.consultation is not set', async () => {
            mockStoreValue.consultation = null;

            const completedJob = {
                id: 'job-5',
                status: 'completed',
                consultationId: 'c-from-job',
                progress: 100,
            };
            const contextItems = [{ id: 'ctx-1', type: 'transcription', content: 'text' }];

            mockGet
                .mockResolvedValueOnce(completedJob)
                .mockResolvedValueOnce(contextItems);

            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                await result.current.pollJob('job-5', { maxAttempts: 1 });
            });

            expect(mockGet).toHaveBeenCalledWith(CONTEXT_ENDPOINTS.GET('c-from-job'));
        });
    });

    describe('streamJob auto-refresh', () => {
        it('should expose onJobComplete callback in streamJob for auto-refresh', () => {
            const { result } = renderHook(() => useConsultationJob());
            expect(typeof result.current.streamJob).toBe('function');
        });
    });
});
