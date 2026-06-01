/**
 * useTenantStorageConfig Hook Tests (TASK-323 Phase 0 / TASK-318 R9)
 *
 * Per-tenant / per-bucket storage provider configuration management.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTenantStorageConfig } from '../useTenantStorageConfig';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { TENANT_STORAGE_CONFIG_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useTenantStorageConfig', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPut = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset(); mockPut.mockReset(); mockDelete.mockReset();
        mockStore = { apiClient: { get: mockGet, put: mockPut, delete: mockDelete }, logger: mockLogger };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('initial state is empty', () => {
        const { result } = renderHook(() => useTenantStorageConfig());
        expect(result.current.configs).toEqual([]);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    describe('list', () => {
        it('GETs LIST and stores configs', async () => {
            const configs = [{ id: 's-1', backend: 's3' }];
            mockGet.mockResolvedValue(configs);
            const { result } = renderHook(() => useTenantStorageConfig());

            let resp: any;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_STORAGE_CONFIG_ENDPOINTS.LIST);
            expect(resp).toEqual(configs);
            expect(result.current.configs).toEqual(configs);
        });

        it('passes includeDisabled=true when requested', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useTenantStorageConfig());

            await act(async () => { await result.current.list({ includeDisabled: true }); });

            const url = mockGet.mock.calls[0][0] as string;
            expect(url).toContain('includeDisabled=true');
        });

        it('omits includeDisabled when false', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useTenantStorageConfig());

            await act(async () => { await result.current.list({ includeDisabled: false }); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_STORAGE_CONFIG_ENDPOINTS.LIST);
        });

        it('surfaces a server 403 as a clean AgenticError(FORBIDDEN)', async () => {
            mockGet.mockRejectedValue(new AgenticError('FORBIDDEN', 'Forbidden'));
            const { result } = renderHook(() => useTenantStorageConfig());

            let caught: unknown;
            await act(async () => { try { await result.current.list(); } catch (e) { caught = e; } });

            expect(caught).toBeInstanceOf(AgenticError);
            expect((caught as AgenticError).code).toBe('FORBIDDEN');
        });
    });

    describe('effective', () => {
        it('GETs EFFECTIVE without bucketId', async () => {
            mockGet.mockResolvedValue({ id: 's-default' });
            const { result } = renderHook(() => useTenantStorageConfig());

            await act(async () => { await result.current.effective(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_STORAGE_CONFIG_ENDPOINTS.EFFECTIVE);
        });

        it('GETs EFFECTIVE with bucketId query', async () => {
            mockGet.mockResolvedValue({ id: 's-b1' });
            const { result } = renderHook(() => useTenantStorageConfig());

            await act(async () => { await result.current.effective('b-1'); });

            const url = mockGet.mock.calls[0][0] as string;
            expect(url).toContain(TENANT_STORAGE_CONFIG_ENDPOINTS.EFFECTIVE);
            expect(url).toContain('bucketId=b-1');
        });
    });

    describe('upsert', () => {
        it('PUTs UPSERT with input', async () => {
            const input = { bucketId: 'b-1', backend: 'azure' };
            const stored = { id: 's-1', ...input };
            mockPut.mockResolvedValue(stored);
            const { result } = renderHook(() => useTenantStorageConfig());

            let resp: any;
            await act(async () => { resp = await result.current.upsert(input); });

            expect(mockPut).toHaveBeenCalledWith(TENANT_STORAGE_CONFIG_ENDPOINTS.UPSERT, input);
            expect(resp).toEqual(stored);
        });
    });

    describe('remove', () => {
        it('DELETEs DELETE(id) and drops from configs', async () => {
            mockGet.mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);
            mockDelete.mockResolvedValue({ id: 's-1' });
            const { result } = renderHook(() => useTenantStorageConfig());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('s-1'); });

            expect(mockDelete).toHaveBeenCalledWith(TENANT_STORAGE_CONFIG_ENDPOINTS.DELETE('s-1'));
            expect(result.current.configs).toEqual([{ id: 's-2' }]);
        });
    });

    describe('SDK not initialized', () => {
        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useTenantStorageConfig());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
