/**
 * useStorage Hook Tests (TASK-032 WS-G)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStorage } from '../useStorage';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { STORAGE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useStorage', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockDelete.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: vi.fn(), delete: mockDelete },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty buckets and files', () => {
            const { result } = renderHook(() => useStorage());
            expect(result.current.buckets).toEqual([]);
            expect(result.current.files).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('listBuckets', () => {
        it('should GET from STORAGE_ENDPOINTS.LIST_BUCKETS and update state', async () => {
            const buckets = [
                { name: 'public', fileCount: 10 },
                { name: 'private', fileCount: 5 },
            ];
            mockGet.mockResolvedValue(buckets);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.listBuckets(); });

            expect(mockGet).toHaveBeenCalledWith(STORAGE_ENDPOINTS.LIST_BUCKETS);
            expect(result.current.buckets).toEqual(buckets);
            expect(resp).toEqual(buckets);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useStorage());

            await act(async () => {
                try { await result.current.listBuckets(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should extract array from paginated wrapper response', async () => {
            const items = [{ name: 'public', fileCount: 10 }, { name: 'private', fileCount: 5 }];
            mockGet.mockResolvedValue({ data: items, count: 2 });
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });

            expect(result.current.buckets).toEqual(items);
            expect(Array.isArray(result.current.buckets)).toBe(true);
        });

        it('should return empty array for unexpected listBuckets response shape', async () => {
            mockGet.mockResolvedValue({ status: 'ok' });
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });

            expect(result.current.buckets).toEqual([]);
        });
    });

    describe('getBucket', () => {
        it('should GET from STORAGE_ENDPOINTS.GET_BUCKET(name)', async () => {
            const bucket = { name: 'public', fileCount: 10, totalSize: 1024 };
            mockGet.mockResolvedValue(bucket);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.getBucket('public'); });

            expect(mockGet).toHaveBeenCalledWith(STORAGE_ENDPOINTS.GET_BUCKET('public'));
            expect(resp).toEqual(bucket);
        });
    });

    describe('listFiles', () => {
        it('should GET from STORAGE_ENDPOINTS.LIST_FILES(bucket) and update state', async () => {
            const files = [
                { key: 'file1.wav', size: 1024, lastModified: '2026-02-20' },
                { key: 'file2.mp3', size: 2048, lastModified: '2026-02-19' },
            ];
            mockGet.mockResolvedValue(files);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.listFiles('public'); });

            expect(mockGet).toHaveBeenCalledWith(STORAGE_ENDPOINTS.LIST_FILES('public'));
            expect(result.current.files).toEqual(files);
            expect(resp).toEqual(files);
        });

        it('should extract array from paginated wrapper response', async () => {
            const items = [{ key: 'file1.wav', size: 1024 }];
            mockGet.mockResolvedValue({ data: items, count: 1 });
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listFiles('public'); });

            expect(result.current.files).toEqual(items);
            expect(Array.isArray(result.current.files)).toBe(true);
        });

        it('should append prefix as query param when provided', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listFiles('public', 'audio/'); });

            expect(mockGet).toHaveBeenCalledWith(`${STORAGE_ENDPOINTS.LIST_FILES('public')}?prefix=audio%2F`);
        });
    });

    describe('getFileInfo', () => {
        it('should GET from STORAGE_ENDPOINTS.GET_FILE(bucket, key)', async () => {
            const fileInfo = { key: 'file1.wav', size: 1024, url: 'https://presigned-url' };
            mockGet.mockResolvedValue(fileInfo);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.getFileInfo('public', 'file1.wav'); });

            expect(mockGet).toHaveBeenCalledWith(STORAGE_ENDPOINTS.GET_FILE('public', 'file1.wav'));
            expect(resp).toEqual(fileInfo);
        });
    });

    describe('deleteFile', () => {
        it('should DELETE from STORAGE_ENDPOINTS.DELETE_FILE(bucket, key)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.deleteFile('public', 'file1.wav'); });

            expect(mockDelete).toHaveBeenCalledWith(STORAGE_ENDPOINTS.DELETE_FILE('public', 'file1.wav'));
        });

        it('should remove file from files array', async () => {
            const files = [
                { key: 'file1.wav', size: 1024 },
                { key: 'file2.mp3', size: 2048 },
            ];
            mockGet.mockResolvedValue(files);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listFiles('public'); });
            await act(async () => { await result.current.deleteFile('public', 'file1.wav'); });

            expect(result.current.files).toEqual([files[1]]);
        });
    });

    describe('checkHealth', () => {
        it('should GET from STORAGE_ENDPOINTS.HEALTH', async () => {
            const health = { status: 'healthy', connected: true };
            mockGet.mockResolvedValue(health);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.checkHealth(); });

            expect(mockGet).toHaveBeenCalledWith(STORAGE_ENDPOINTS.HEALTH);
            expect(resp).toEqual(health);
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useStorage());

            await expect(
                act(async () => { await result.current.listBuckets(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const buckets = [{ name: 'public' }];
            mockGet.mockResolvedValue(buckets);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });
            expect(result.current.buckets).toEqual(buckets);
        });
    });

    describe('empty bucket name filtering', () => {
        it('should filter out buckets with empty names', async () => {
            const bucketsWithEmpty = [
                { name: '', type: 'public' },
                { name: 'my-private-bucket', type: 'private' },
            ];
            mockGet.mockResolvedValue(bucketsWithEmpty);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });

            expect(result.current.buckets).toHaveLength(1);
            expect(result.current.buckets[0].name).toBe('my-private-bucket');
        });

        it('should filter out buckets with whitespace-only names', async () => {
            const bucketsWithWhitespace = [
                { name: '  ', type: 'public' },
                { name: 'valid-bucket', type: 'private' },
            ];
            mockGet.mockResolvedValue(bucketsWithWhitespace);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });

            expect(result.current.buckets).toHaveLength(1);
            expect(result.current.buckets[0].name).toBe('valid-bucket');
        });

        it('should return empty array when all bucket names are empty', async () => {
            const allEmpty = [
                { name: '', type: 'public' },
                { name: '', type: 'private' },
            ];
            mockGet.mockResolvedValue(allEmpty);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });

            expect(result.current.buckets).toEqual([]);
        });
    });

    describe('createBucket', () => {
        it('should POST to STORAGE_ENDPOINTS.CREATE_BUCKET with name and type', async () => {
            const created = { name: 'new-bucket', type: 'private', createdAt: '2026-02-24' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useStorage());

            let resp: unknown;
            await act(async () => { resp = await result.current.createBucket('new-bucket', 'private'); });

            expect(mockPost).toHaveBeenCalledWith(
                STORAGE_ENDPOINTS.CREATE_BUCKET,
                { name: 'new-bucket', type: 'private' },
            );
            expect(resp).toEqual(created);
            expect(result.current.buckets).toContainEqual(expect.objectContaining({ name: 'new-bucket' }));
        });
    });

    describe('deleteBucket', () => {
        it('should DELETE to STORAGE_ENDPOINTS.DELETE_BUCKET and remove from state', async () => {
            mockGet.mockResolvedValue([
                { name: 'bucket-a', type: 'public' },
                { name: 'bucket-b', type: 'private' },
            ]);
            const { result } = renderHook(() => useStorage());

            await act(async () => { await result.current.listBuckets(); });
            expect(result.current.buckets).toHaveLength(2);

            mockDelete.mockResolvedValue(undefined);
            await act(async () => { await result.current.deleteBucket('bucket-a'); });

            expect(mockDelete).toHaveBeenCalledWith(STORAGE_ENDPOINTS.DELETE_BUCKET('bucket-a'));
            expect(result.current.buckets).toHaveLength(1);
            expect(result.current.buckets[0].name).toBe('bucket-b');
        });
    });

    describe('listFiles with empty bucket name', () => {
        it('should throw when bucket name is empty', async () => {
            const { result } = renderHook(() => useStorage());

            await expect(
                act(async () => { await result.current.listFiles(''); })
            ).rejects.toThrow();
        });

        it('should throw when bucket name is whitespace only', async () => {
            const { result } = renderHook(() => useStorage());

            await expect(
                act(async () => { await result.current.listFiles('  '); })
            ).rejects.toThrow();
        });
    });
});
