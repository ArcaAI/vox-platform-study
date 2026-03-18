/**
 * useConsultationJob Hook Tests (TASK-032 WS-A)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConsultationJob } from '../useConsultationJob';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_JOB_ENDPOINTS } from '../../core/constants';
import { SSEClient } from '../../core/SSEClient'; // mocked below

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

let mockSSEInstance: any;

vi.mock('../../core/SSEClient', () => {
    const MockSSEClient = function (this: any) {
        Object.assign(this, mockSSEInstance);
        return this;
    } as any;
    MockSSEClient.prototype = {};
    return { SSEClient: MockSSEClient };
});

describe('useConsultationJob', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockDelete = vi.fn();
    const mockPatch = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockDelete.mockReset();
        mockPatch.mockReset();

        mockSSEInstance = {
            connect: vi.fn(),
            disconnect: vi.fn(),
            onEvent: vi.fn(),
            onError: vi.fn(),
            onOpen: vi.fn(),
            onMessage: vi.fn(),
            isConnected: vi.fn().mockReturnValue(false),
            getUrl: vi.fn().mockReturnValue(null),
        };

        mockStore = {
            apiClient: {
                get: mockGet,
                post: vi.fn(),
                patch: mockPatch,
                delete: mockDelete,
                getBaseUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1'),
                getAccessToken: vi.fn().mockReturnValue('test-jwt-token'),
            },
            logger: mockLogger,
            consultation: { id: 'consultation-1' },
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('initial state', () => {
        it('should return null job, idle status, not streaming', () => {
            const { result } = renderHook(() => useConsultationJob());
            expect(result.current.job).toBeNull();
            expect(result.current.status).toBe('idle');
            expect(result.current.isStreaming).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('getJob', () => {
        it('should GET from CONSULTATION_JOB_ENDPOINTS.GET and update state', async () => {
            const job = { id: 'job-1', status: 'processing', progress: 50, consultationId: 'c-1' };
            mockGet.mockResolvedValue(job);
            const { result } = renderHook(() => useConsultationJob());

            let resp: unknown;
            await act(async () => { resp = await result.current.getJob('job-1'); });

            expect(mockGet).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.GET('job-1'));
            expect(result.current.job).toEqual(job);
            expect(result.current.status).toBe('processing');
            expect(resp).toEqual(job);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Job not found'));
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                try { await result.current.getJob('bad-id'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Job not found');
        });

        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useConsultationJob());

            await expect(
                act(async () => { await result.current.getJob('job-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('cancelJob', () => {
        it('should PATCH from CONSULTATION_JOB_ENDPOINTS.CANCEL', async () => {
            mockPatch.mockResolvedValue(undefined);
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => { await result.current.cancelJob('job-1'); });

            expect(mockPatch).toHaveBeenCalledWith(CONSULTATION_JOB_ENDPOINTS.CANCEL('job-1'), {});
            expect(result.current.status).toBe('cancelled');
        });

        it('should set error on failure', async () => {
            mockPatch.mockRejectedValue(new Error('Cannot cancel'));
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                try { await result.current.cancelJob('job-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Cannot cancel');
        });
    });

    describe('streamJob', () => {
        it('should create SSEClient and connect with auth token', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onStatus: vi.fn(), onProgress: vi.fn(), onResult: vi.fn(), onError: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            expect(mockSSEInstance.connect).toHaveBeenCalledWith(
                'http://localhost:8868/api/v1/consultations/jobs/job-1/stream',
                expect.objectContaining({
                    autoReconnect: true,
                    authToken: 'test-jwt-token',
                }),
            );
            expect(result.current.isStreaming).toBe(true);
        });

        it('should register event listeners for status, progress, and result', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onStatus: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            expect(mockSSEInstance.onEvent).toHaveBeenCalledWith('status', expect.any(Function));
            expect(mockSSEInstance.onEvent).toHaveBeenCalledWith('progress', expect.any(Function));
            expect(mockSSEInstance.onEvent).toHaveBeenCalledWith('result', expect.any(Function));
            expect(mockSSEInstance.onError).toHaveBeenCalledWith(expect.any(Function));
        });

        it('should handle status events and update state', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onStatus: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const statusHandler = mockSSEInstance.onEvent.mock.calls.find(
                (call: any[]) => call[0] === 'status'
            )?.[1];

            act(() => {
                statusHandler('{"status":"processing"}');
            });

            expect(callbacks.onStatus).toHaveBeenCalledWith('processing');
            expect(result.current.status).toBe('processing');
        });

        it('should disconnect SSEClient on terminal status', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onStatus: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const statusHandler = mockSSEInstance.onEvent.mock.calls.find(
                (call: any[]) => call[0] === 'status'
            )?.[1];

            act(() => {
                statusHandler('{"status":"completed","consultationId":"c-1"}');
            });

            expect(mockSSEInstance.disconnect).toHaveBeenCalled();
            expect(result.current.isStreaming).toBe(false);
        });

        it('should return cleanup function that disconnects SSEClient', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = {};

            let cleanup: () => void;
            act(() => {
                cleanup = result.current.streamJob('job-1', callbacks);
            });

            act(() => {
                cleanup();
            });

            expect(mockSSEInstance.disconnect).toHaveBeenCalled();
            expect(result.current.isStreaming).toBe(false);
        });

        it('should handle SSE error events', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onError: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const errorHandler = mockSSEInstance.onError.mock.calls[0]?.[0];

            act(() => {
                errorHandler();
            });

            expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
            expect(result.current.error?.message).toBe('SSE connection error');
        });

        it('should throw when apiClient is null', () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useConsultationJob());

            expect(() => {
                result.current.streamJob('job-1', {});
            }).toThrow('SDK not initialized');
        });

        it('should handle progress events', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onProgress: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const progressHandler = mockSSEInstance.onEvent.mock.calls.find(
                (call: any[]) => call[0] === 'progress'
            )?.[1];

            act(() => {
                progressHandler('{"progress":75}');
            });

            expect(callbacks.onProgress).toHaveBeenCalledWith(75);
        });

        it('should handle result events', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onResult: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const resultHandler = mockSSEInstance.onEvent.mock.calls.find(
                (call: any[]) => call[0] === 'result'
            )?.[1];

            act(() => {
                resultHandler('{"summary":"Test summary"}');
            });

            expect(callbacks.onResult).toHaveBeenCalledWith({ summary: 'Test summary' });
        });

        it('should handle malformed JSON in status events gracefully', () => {
            const { result } = renderHook(() => useConsultationJob());
            const callbacks = { onStatus: vi.fn() };

            act(() => {
                result.current.streamJob('job-1', callbacks);
            });

            const statusHandler = mockSSEInstance.onEvent.mock.calls.find(
                (call: any[]) => call[0] === 'status'
            )?.[1];

            act(() => {
                statusHandler('not-valid-json');
            });

            expect(callbacks.onStatus).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('pollJob', () => {
        it('should poll until terminal state and return completed job', async () => {
            const pending = { id: 'job-1', status: 'processing', progress: 50, consultationId: 'c-1' };
            const completed = { id: 'job-1', status: 'completed', progress: 100, consultationId: 'c-1', result: 'Summary text' };
            mockGet
                .mockResolvedValueOnce(pending)
                .mockResolvedValueOnce(completed);
            const { result } = renderHook(() => useConsultationJob());

            const pollPromise = act(async () => {
                return result.current.pollJob('job-1', { intervalMs: 1000, maxAttempts: 5 });
            });

            await act(async () => { vi.advanceTimersByTime(1000); });
            await act(async () => { vi.advanceTimersByTime(1000); });

            const resp = await pollPromise;
            expect(resp).toEqual(completed);
            expect(result.current.status).toBe('completed');
        });

        it('should throw when max attempts exceeded', async () => {
            const pending = { id: 'job-1', status: 'processing', progress: 50, consultationId: 'c-1' };
            mockGet.mockResolvedValue(pending);
            const { result } = renderHook(() => useConsultationJob());

            const pollPromise = act(async () => {
                return result.current.pollJob('job-1', { intervalMs: 100, maxAttempts: 2 });
            });

            await act(async () => { vi.advanceTimersByTime(100); });
            await act(async () => { vi.advanceTimersByTime(100); });
            await act(async () => { vi.advanceTimersByTime(100); });

            await expect(pollPromise).rejects.toThrow('Polling exceeded max attempts');
        });
    });

    describe('error clearing', () => {
        it('should clear error on subsequent success', async () => {
            const job = { id: 'job-1', status: 'completed', progress: 100, consultationId: 'c-1' };
            mockGet.mockRejectedValueOnce(new Error('Fail')).mockResolvedValueOnce(job);
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => {
                try { await result.current.getJob('job-1'); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fail');

            await act(async () => { await result.current.getJob('job-1'); });
            expect(result.current.error).toBeNull();
        });
    });

    describe('null logger', () => {
        it('should work when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const job = { id: 'job-1', status: 'completed', progress: 100, consultationId: 'c-1' };
            mockGet.mockResolvedValue(job);
            const { result } = renderHook(() => useConsultationJob());

            await act(async () => { await result.current.getJob('job-1'); });
            expect(result.current.job).toEqual(job);
        });
    });

    describe('BUG-14: pollJob timer cancellation on unmount', () => {
        it('should stop polling when component unmounts', async () => {
            let callCount = 0;
            mockGet.mockImplementation(async () => {
                callCount++;
                return { id: 'job-1', status: 'processing', progress: callCount * 10, consultationId: 'c-1' };
            });

            const { result, unmount } = renderHook(() => useConsultationJob());

            let pollPromise: Promise<any>;
            act(() => {
                pollPromise = result.current.pollJob('job-1', { intervalMs: 100, maxAttempts: 50 });
            });

            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            const callsBeforeUnmount = callCount;

            unmount();

            await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
            expect(callCount).toBe(callsBeforeUnmount);
        });
    });

    describe('SSEClient cleanup on unmount', () => {
        it('should disconnect SSEClient when component unmounts', () => {
            const { result, unmount } = renderHook(() => useConsultationJob());

            act(() => {
                result.current.streamJob('job-1', {});
            });

            unmount();

            expect(mockSSEInstance.disconnect).toHaveBeenCalled();
        });
    });
});
