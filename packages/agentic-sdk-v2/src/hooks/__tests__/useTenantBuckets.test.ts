/**
 * useTenantBuckets Hook Tests
 *
 * Per-tenant storage bucket management for TENANT_ADMIN / GLOBAL_ADMIN.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTenantBuckets } from '../useTenantBuckets';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { TENANT_BUCKET_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useTenantBuckets', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPut = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset(); mockPost.mockReset(); mockPut.mockReset(); mockDelete.mockReset();
        mockStore = { apiClient: { get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }, logger: mockLogger };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('initial state is empty', () => {
        const { result } = renderHook(() => useTenantBuckets());
        expect(result.current.buckets).toEqual([]);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    describe('list', () => {
        it('GETs LIST and stores buckets', async () => {
            const buckets = [{ id: 'b-1', name: 'audio' }];
            mockGet.mockResolvedValue(buckets);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.LIST);
            expect(resp).toEqual(buckets);
            expect(result.current.buckets).toEqual(buckets);
        });

        it('surfaces a server 403 as a clean AgenticError(FORBIDDEN)', async () => {
            mockGet.mockRejectedValue(new AgenticError('FORBIDDEN', 'Forbidden'));
            const { result } = renderHook(() => useTenantBuckets());

            let caught: unknown;
            await act(async () => { try { await result.current.list(); } catch (e) { caught = e; } });

            expect(caught).toBeInstanceOf(AgenticError);
            expect((caught as AgenticError).code).toBe('FORBIDDEN');
        });
    });

    describe('get', () => {
        it('GETs GET(id)', async () => {
            const bucket = { id: 'b-1' };
            mockGet.mockResolvedValue(bucket);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.get('b-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.GET('b-1'));
            expect(resp).toEqual(bucket);
        });
    });

    describe('tree', () => {
        it('GETs TREE(id) without prefix', async () => {
            mockGet.mockResolvedValue({ nodes: [] });
            const { result } = renderHook(() => useTenantBuckets());

            await act(async () => { await result.current.tree('b-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.TREE('b-1'));
        });

        it('GETs TREE(id) with prefix query', async () => {
            mockGet.mockResolvedValue({ nodes: [] });
            const { result } = renderHook(() => useTenantBuckets());

            await act(async () => { await result.current.tree('b-1', '2026/04'); });

            const url = mockGet.mock.calls[0][0] as string;
            expect(url).toContain(TENANT_BUCKET_ENDPOINTS.TREE('b-1'));
            expect(url).toContain(`prefix=${encodeURIComponent('2026/04')}`);
        });
    });

    // Read-only object browser for the Stores detail surface.
    describe('listObjects', () => {
        it('GETs LIST_OBJECTS(id) and returns the object rows', async () => {
            const objects = [{ key: '2026/07/a.wav', size: 1024, lastModified: '2026-07-01T00:00:00Z' }];
            mockGet.mockResolvedValue(objects);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.listObjects('b-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.LIST_OBJECTS('b-1'));
            expect(resp).toEqual(objects);
        });

        it('GETs LIST_OBJECTS(id) with a prefix query', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useTenantBuckets());

            await act(async () => { await result.current.listObjects('b-1', '2026/07'); });

            const url = mockGet.mock.calls[0][0] as string;
            expect(url).toContain(TENANT_BUCKET_ENDPOINTS.LIST_OBJECTS('b-1'));
            expect(url).toContain(`prefix=${encodeURIComponent('2026/07')}`);
        });
    });

    describe('presignedUrl', () => {
        it('GETs PRESIGNED_URL(id) with required key query', async () => {
            mockGet.mockResolvedValue({ url: 'https://signed' });
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.presignedUrl('b-1', 'a/b.wav'); });

            const url = mockGet.mock.calls[0][0] as string;
            expect(url).toContain(TENANT_BUCKET_ENDPOINTS.PRESIGNED_URL('b-1'));
            expect(url).toContain(`key=${encodeURIComponent('a/b.wav')}`);
            expect(resp).toEqual({ url: 'https://signed' });
        });
    });

    describe('defaults', () => {
        it('getDefaults GETs DEFAULTS', async () => {
            const defaults = { audio: 'b-1' };
            mockGet.mockResolvedValue(defaults);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.getDefaults(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.DEFAULTS);
            expect(resp).toEqual(defaults);
        });

        it('setDefaults PUTs DEFAULTS with input', async () => {
            const input = { audio: 'b-2' };
            mockPut.mockResolvedValue(input);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.setDefaults(input); });

            expect(mockPut).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.DEFAULTS, input);
            expect(resp).toEqual(input);
        });
    });

    describe('create', () => {
        it('POSTs CREATE and appends to buckets', async () => {
            const created = { id: 'b-new', name: 'custom' };
            mockGet.mockResolvedValue([{ id: 'b-1' }]);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useTenantBuckets());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ name: 'custom' }); });

            expect(mockPost).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.CREATE, { name: 'custom' });
            expect(result.current.buckets).toEqual([{ id: 'b-1' }, created]);
        });
    });

    describe('remove', () => {
        it('DELETEs DELETE(id) and drops from buckets', async () => {
            mockGet.mockResolvedValue([{ id: 'b-1' }, { id: 'b-2' }]);
            mockDelete.mockResolvedValue({ id: 'b-1' });
            const { result } = renderHook(() => useTenantBuckets());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('b-1'); });

            expect(mockDelete).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.DELETE('b-1'));
            expect(result.current.buckets).toEqual([{ id: 'b-2' }]);
        });
    });

    describe('deleteObject', () => {
        it('DELETEs DELETE_OBJECT(id) with required key query', async () => {
            mockDelete.mockResolvedValue({ key: 'a/b.wav', deleted: true });
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.deleteObject('b-1', 'a/b.wav'); });

            const url = mockDelete.mock.calls[0][0] as string;
            expect(url).toContain(TENANT_BUCKET_ENDPOINTS.DELETE_OBJECT('b-1'));
            expect(url).toContain(`key=${encodeURIComponent('a/b.wav')}`);
            expect(resp).toEqual({ key: 'a/b.wav', deleted: true });
        });
    });

    describe('provision', () => {
        it('POSTs PROVISION(tenantId)', async () => {
            const provisioned = [{ id: 'b-1' }];
            mockPost.mockResolvedValue(provisioned);
            const { result } = renderHook(() => useTenantBuckets());

            let resp: any;
            await act(async () => { resp = await result.current.provision('t-1'); });

            expect(mockPost).toHaveBeenCalledWith(TENANT_BUCKET_ENDPOINTS.PROVISION('t-1'), {});
            expect(resp).toEqual(provisioned);
        });
    });

    describe('SDK not initialized', () => {
        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useTenantBuckets());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
