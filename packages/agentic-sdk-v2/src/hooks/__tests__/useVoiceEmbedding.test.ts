/**
 * useVoiceEmbedding Hook Tests (TASK-033)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceEmbedding } from '../useVoiceEmbedding';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { VOICE_EMBEDDING_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

function createMockStore() {
    return {
        apiClient: {
            get: vi.fn(),
            post: vi.fn(),
            patch: vi.fn(),
            delete: vi.fn(),
        },
        logger: createMockLogger(),
    };
}

describe('useVoiceEmbedding', () => {
    let mockStore: ReturnType<typeof createMockStore>;

    beforeEach(() => {
        mockStore = createMockStore();
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return null status and loading=false', () => {
            const { result } = renderHook(() => useVoiceEmbedding());
            expect(result.current.status).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.isUploading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('upload', () => {
        it('should POST to VOICE_EMBEDDING_ENDPOINTS.UPLOAD and return response', async () => {
            const mockResponse = {
                userId: 'user-123',
                speakerId: 'user-123',
                embeddingId: 'emb-001',
                dimensions: 512,
                createdAt: '2026-02-21T00:00:00Z',
                audioFileKey: 'voice-samples/tenant-001/user-123',
            };
            mockStore.apiClient.post.mockResolvedValue(mockResponse);

            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            let resp: unknown;
            await act(async () => {
                resp = await result.current.upload('user-123', audioFile);
            });

            expect(mockStore.apiClient.post).toHaveBeenCalledOnce();
            const [endpoint, formData] = mockStore.apiClient.post.mock.calls[0];
            expect(endpoint).toBe(VOICE_EMBEDDING_ENDPOINTS.UPLOAD('user-123'));
            expect(formData).toBeInstanceOf(FormData);
            expect(resp).toEqual(mockResponse);
        });

        it('should set error on failure', async () => {
            mockStore.apiClient.post.mockRejectedValue(new Error('Upload failed'));
            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await act(async () => {
                try { await result.current.upload('user-123', audioFile); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Upload failed');
        });

        it('should update status with embedding data after successful upload', async () => {
            const mockResponse = {
                userId: 'user-123',
                speakerId: 'user-123',
                embeddingId: 'emb-001',
                dimensions: 512,
                createdAt: '2026-02-21T00:00:00Z',
                audioFileKey: 'voice-samples/tenant-001/user-123',
            };
            mockStore.apiClient.post.mockResolvedValue(mockResponse);

            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await act(async () => { await result.current.upload('user-123', audioFile); });

            expect(result.current.status).toEqual({
                userId: 'user-123',
                exists: true,
                dimensions: 512,
                createdAt: '2026-02-21T00:00:00Z',
                audioFileKey: 'voice-samples/tenant-001/user-123',
            });
        });

        it('should clear previous error on new upload attempt', async () => {
            mockStore.apiClient.post.mockRejectedValueOnce(new Error('first failure'));
            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await act(async () => {
                try { await result.current.upload('user-123', audioFile); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('first failure');

            const successResponse = {
                userId: 'user-123', speakerId: 'user-123', embeddingId: 'emb-002',
                dimensions: 512, createdAt: '2026-02-21T00:00:00Z', audioFileKey: 'key',
            };
            mockStore.apiClient.post.mockResolvedValueOnce(successResponse);

            await act(async () => { await result.current.upload('user-123', audioFile); });
            expect(result.current.error).toBeNull();
        });

        it('should reset isUploading to false after failure', async () => {
            mockStore.apiClient.post.mockRejectedValue(new Error('fail'));
            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await act(async () => {
                try { await result.current.upload('user-123', audioFile); } catch { /* expected */ }
            });

            expect(result.current.isUploading).toBe(false);
        });

        it('should throw the error for the caller to catch', async () => {
            mockStore.apiClient.post.mockRejectedValue(new Error('Upload failed'));
            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await expect(
                act(async () => { await result.current.upload('user-123', audioFile); }),
            ).rejects.toThrow('Upload failed');
        });
    });

    describe('getStatus', () => {
        it('should GET from VOICE_EMBEDDING_ENDPOINTS.STATUS and update state', async () => {
            const mockStatus = {
                userId: 'user-123',
                exists: true,
                dimensions: 512,
                audioFileKey: 'voice-samples/tenant-001/user-123',
            };
            mockStore.apiClient.get.mockResolvedValue(mockStatus);

            const { result } = renderHook(() => useVoiceEmbedding());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.getStatus('user-123');
            });

            expect(mockStore.apiClient.get).toHaveBeenCalledWith(VOICE_EMBEDDING_ENDPOINTS.STATUS('user-123'));
            expect(result.current.status).toEqual(mockStatus);
            expect(resp).toEqual(mockStatus);
        });

        it('should set error on failure', async () => {
            mockStore.apiClient.get.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => {
                try { await result.current.getStatus('user-123'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should reset isLoading to false after failure', async () => {
            mockStore.apiClient.get.mockRejectedValue(new Error('network error'));
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => {
                try { await result.current.getStatus('user-123'); } catch { /* expected */ }
            });

            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('remove', () => {
        it('should DELETE from VOICE_EMBEDDING_ENDPOINTS.REMOVE', async () => {
            mockStore.apiClient.delete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => {
                await result.current.remove('user-123');
            });

            expect(mockStore.apiClient.delete).toHaveBeenCalledWith(VOICE_EMBEDDING_ENDPOINTS.REMOVE('user-123'));
        });

        it('should clear status after remove', async () => {
            const mockStatus = { userId: 'user-123', exists: true, dimensions: 512 };
            mockStore.apiClient.get.mockResolvedValue(mockStatus);
            mockStore.apiClient.delete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => { await result.current.getStatus('user-123'); });
            expect(result.current.status).toEqual(mockStatus);

            await act(async () => { await result.current.remove('user-123'); });
            expect(result.current.status).toBeNull();
        });

        it('should set error when remove fails', async () => {
            mockStore.apiClient.delete.mockRejectedValue(new Error('Delete failed'));
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => {
                try { await result.current.remove('user-123'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Delete failed');
        });

        it('should reset isLoading to false after remove failure', async () => {
            mockStore.apiClient.delete.mockRejectedValue(new Error('timeout'));
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => {
                try { await result.current.remove('user-123'); } catch { /* expected */ }
            });

            expect(result.current.isLoading).toBe(false);
        });

        it('should throw the error for the caller to catch on remove', async () => {
            mockStore.apiClient.delete.mockRejectedValue(new Error('Delete failed'));
            const { result } = renderHook(() => useVoiceEmbedding());

            await expect(
                act(async () => { await result.current.remove('user-123'); }),
            ).rejects.toThrow('Delete failed');
        });
    });

    describe('SDK not initialized', () => {
        it('should throw on getStatus when apiClient is null', async () => {
            (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
            const { result } = renderHook(() => useVoiceEmbedding());

            await expect(
                act(async () => { await result.current.getStatus('user-123'); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw on upload when apiClient is null', async () => {
            (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
            const { result } = renderHook(() => useVoiceEmbedding());
            const audioFile = new Blob(['audio-data'], { type: 'audio/wav' });

            await expect(
                act(async () => { await result.current.upload('user-123', audioFile); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw on remove when apiClient is null', async () => {
            (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
            const { result } = renderHook(() => useVoiceEmbedding());

            await expect(
                act(async () => { await result.current.remove('user-123'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            (useAgenticStore as any).mockReturnValue({ ...mockStore, logger: null });
            const mockStatus = { userId: 'user-123', exists: false };
            mockStore.apiClient.get.mockResolvedValue(mockStatus);
            const { result } = renderHook(() => useVoiceEmbedding());

            await act(async () => { await result.current.getStatus('user-123'); });
            expect(result.current.status).toEqual(mockStatus);
        });
    });
});
