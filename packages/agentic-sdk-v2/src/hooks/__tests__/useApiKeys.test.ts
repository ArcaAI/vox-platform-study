/**
 * useApiKeys Hook Tests (TASK-032 WS-G)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useApiKeys } from '../useApiKeys';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { API_KEY_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useApiKeys', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty apiKeys array', () => {
            const { result } = renderHook(() => useApiKeys());
            expect(result.current.apiKeys).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from API_KEY_ENDPOINTS.LIST and update state', async () => {
            const keys = [
                { id: 'k-1', name: 'Test Key', prefix: 'hope_live_abc', status: 'ACTIVE' },
                { id: 'k-2', name: 'Dev Key', prefix: 'hope_test_def', status: 'ACTIVE' },
            ];
            mockGet.mockResolvedValue(keys);
            const { result } = renderHook(() => useApiKeys());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(API_KEY_ENDPOINTS.LIST);
            expect(result.current.apiKeys[0].name).toBe('Test Key');
            expect(result.current.apiKeys[0].status).toBe('active');
            expect(result.current.apiKeys[1].name).toBe('Dev Key');
            expect(result.current.apiKeys).toHaveLength(2);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useApiKeys());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should extract array from paginated wrapper response', async () => {
            mockGet.mockResolvedValue({ data: [{ id: 'k-1', name: 'Test Key', prefix: 'hope_live_abc', status: 'ACTIVE' }], count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(Array.isArray(result.current.apiKeys)).toBe(true);
            expect(result.current.apiKeys[0].name).toBe('Test Key');
            expect(result.current.apiKeys[0].status).toBe('active');
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ status: 'ok' });
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys).toEqual([]);
        });
    });

    describe('get', () => {
        it('should GET from API_KEY_ENDPOINTS.GET(id)', async () => {
            const key = { id: 'k-1', name: 'Test Key', prefix: 'hope_live_abc' };
            mockGet.mockResolvedValue(key);
            const { result } = renderHook(() => useApiKeys());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('k-1'); });

            expect(mockGet).toHaveBeenCalledWith(API_KEY_ENDPOINTS.GET('k-1'));
            expect(resp).toEqual(key);
        });
    });

    describe('create', () => {
        it('should POST to API_KEY_ENDPOINTS.CREATE with mapped fields', async () => {
            const input = { name: 'New Key', type: 'live' };
            const created = { id: 'k-new', keyName: 'New Key', rawKey: 'hope_live_abc123_chk' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useApiKeys());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(
                API_KEY_ENDPOINTS.CREATE,
                expect.objectContaining({ keyName: 'New Key', keyType: 'LIVE' }),
            );
            expect(resp).toEqual(created);
        });

        it('should add created key to apiKeys array', async () => {
            const existing = [{ id: 'k-1', name: 'Existing' }];
            const created = { id: 'k-new', name: 'New Key' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ name: 'New Key' }); });

            expect(result.current.apiKeys).toHaveLength(2);
            expect(result.current.apiKeys[1].id).toBe('k-new');
        });
    });

    describe('update', () => {
        it('should PATCH to API_KEY_ENDPOINTS.UPDATE(id)', async () => {
            const updated = { id: 'k-1', name: 'Updated Key' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useApiKeys());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('k-1', { name: 'Updated Key' });
            });

            expect(mockPatch).toHaveBeenCalledWith(API_KEY_ENDPOINTS.UPDATE('k-1'), { name: 'Updated Key' });
            expect(resp).toEqual(updated);
        });

        it('should replace matching key in apiKeys array', async () => {
            const initial = [
                { id: 'k-1', name: 'Key 1' },
                { id: 'k-2', name: 'Key 2' },
            ];
            const updated = { id: 'k-1', name: 'Key 1 Updated' };
            mockGet.mockResolvedValue(initial);
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.update('k-1', { name: 'Key 1 Updated' }); });

            expect(result.current.apiKeys[0].name).toBe('Key 1 Updated');
            expect(result.current.apiKeys[1].name).toBe('Key 2');
        });
    });

    describe('remove', () => {
        it('should DELETE from API_KEY_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.remove('k-1'); });

            expect(mockDelete).toHaveBeenCalledWith(API_KEY_ENDPOINTS.DELETE('k-1'));
        });

        it('should remove key from apiKeys array', async () => {
            const initial = [
                { id: 'k-1', name: 'Key 1' },
                { id: 'k-2', name: 'Key 2' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('k-1'); });

            expect(result.current.apiKeys).toHaveLength(1);
            expect(result.current.apiKeys[0].id).toBe('k-2');
        });
    });

    describe('revoke', () => {
        it('should POST to API_KEY_ENDPOINTS.REVOKE(id)', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.revoke('k-1'); });

            expect(mockPost).toHaveBeenCalledWith(API_KEY_ENDPOINTS.REVOKE('k-1'), undefined);
        });
    });

    // TASK-390 #23 (K5) — rotate endpoint.
    describe('rotate', () => {
        it('should POST to API_KEY_ENDPOINTS.ROTATE(id) and return the new raw key', async () => {
            const rotated = { apiKey: { id: 'k-2', keyName: 'Key' }, rawKey: 'hope_live_rotated_chk' };
            mockPost.mockResolvedValue(rotated);
            const { result } = renderHook(() => useApiKeys());

            let resp: any;
            await act(async () => { resp = await result.current.rotate('k-1'); });

            expect(mockPost).toHaveBeenCalledWith(API_KEY_ENDPOINTS.ROTATE('k-1'), undefined);
            expect(resp).toEqual(rotated);
        });
    });

    describe('getUsage', () => {
        it('should GET from API_KEY_ENDPOINTS.USAGE(id)', async () => {
            const usage = { totalRequests: 100, lastUsedAt: '2026-02-20T00:00:00Z' };
            mockGet.mockResolvedValue(usage);
            const { result } = renderHook(() => useApiKeys());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUsage('k-1'); });

            expect(mockGet).toHaveBeenCalledWith(API_KEY_ENDPOINTS.USAGE('k-1'));
            expect(resp).toEqual(usage);
        });
    });

    describe('response field normalization', () => {
        it('should normalize keyName to name in list response', async () => {
            const apiResponse = [
                { id: 'k-1', keyName: 'Production Key', keyPrefix: 'hope_live_abc', keyType: 'SDK', keyStatus: 'ACTIVE' },
            ];
            mockGet.mockResolvedValue(apiResponse);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys[0].name).toBe('Production Key');
            expect(result.current.apiKeys[0].prefix).toBe('hope_live_abc');
            expect(result.current.apiKeys[0].type).toBe('SDK');
            expect(result.current.apiKeys[0].status).toBe('active');
        });

        it('should lowercase keyStatus to status', async () => {
            const apiResponse = [
                { id: 'k-1', keyName: 'Key', keyStatus: 'REVOKED' },
            ];
            mockGet.mockResolvedValue(apiResponse);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys[0].status).toBe('revoked');
        });

        it('should preserve already-normalized fields', async () => {
            const apiResponse = [
                { id: 'k-1', name: 'Already Normal', prefix: 'hope_abc', type: 'SDK', status: 'active' },
            ];
            mockGet.mockResolvedValue(apiResponse);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys[0].name).toBe('Already Normal');
            expect(result.current.apiKeys[0].status).toBe('active');
        });

        it('should handle missing optional fields gracefully', async () => {
            const apiResponse = [{ id: 'k-1' }];
            mockGet.mockResolvedValue(apiResponse);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys[0].id).toBe('k-1');
            expect(result.current.apiKeys[0].name).toBeUndefined();
            expect(result.current.apiKeys[0].status).toBe('');
        });

        it('should normalize paginated wrapper response', async () => {
            const apiResponse = {
                data: [{ id: 'k-1', keyName: 'Wrapped Key', keyStatus: 'ACTIVE', keyType: 'WEBHOOK', keyPrefix: 'hope_wh' }],
                count: 1, page: 1, limit: 10,
            };
            mockGet.mockResolvedValue(apiResponse);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });

            expect(result.current.apiKeys[0].name).toBe('Wrapped Key');
            expect(result.current.apiKeys[0].status).toBe('active');
            expect(result.current.apiKeys[0].type).toBe('WEBHOOK');
            expect(result.current.apiKeys[0].prefix).toBe('hope_wh');
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useApiKeys());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([]);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fetch failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            mockGet.mockResolvedValue([{ id: 'k-1', name: 'Key' }]);
            const { result } = renderHook(() => useApiKeys());

            await act(async () => { await result.current.list(); });
            expect(result.current.apiKeys[0].name).toBe('Key');
            expect(result.current.apiKeys).toHaveLength(1);
        });
    });
});
