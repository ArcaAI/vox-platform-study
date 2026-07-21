/**
 * useTenants Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTenants } from '../useTenants';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { TENANT_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useTenants', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();
    // `update` now reads the ETag and replays it as `If-Match`.
    const mockGetWithEtag = vi.fn();
    const mockPatchWithIfMatch = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();
        mockGetWithEtag.mockReset();
        mockPatchWithIfMatch.mockReset();

        mockStore = {
            apiClient: {
                get: mockGet,
                post: mockPost,
                patch: mockPatch,
                delete: mockDelete,
                getWithEtag: mockGetWithEtag,
                patchWithIfMatch: mockPatchWithIfMatch,
            },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty tenants and null currentTenant', () => {
            const { result } = renderHook(() => useTenants());
            expect(result.current.tenants).toEqual([]);
            expect(result.current.currentTenant).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from TENANT_ENDPOINTS.LIST and update state', async () => {
            const tenants = [
                { id: 't-1', name: 'Clinic A', codeName: 'clinic-a' },
                { id: 't-2', name: 'Hospital B', codeName: 'hospital-b' },
            ];
            mockGet.mockResolvedValue(tenants);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.LIST);
            expect(result.current.tenants).toEqual(tenants);
            expect(resp).toEqual(tenants);
        });

        it('should return tenants with key field', async () => {
            const tenants = [
                { id: 't-1', name: 'Clinic A', key: 'clinic-a' },
                { id: 't-2', name: 'Hospital B', key: 'hospital-b' },
            ];
            mockGet.mockResolvedValue(tenants);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });

            expect(result.current.tenants[0]).toHaveProperty('key', 'clinic-a');
            expect(result.current.tenants[1]).toHaveProperty('key', 'hospital-b');
        });

        it('should pass pagination params as query string', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useTenants());

            await act(async () => {
                await result.current.list({ page: 2, limit: 10 });
            });

            expect(mockGet).toHaveBeenCalledWith(`${TENANT_ENDPOINTS.LIST}?page=2&limit=10`);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useTenants());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should handle paginated response format', async () => {
            const paginatedResponse = {
                count: 2,
                limit: 10,
                page: 1,
                data: [
                    { id: 't-1', name: 'Clinic A' },
                    { id: 't-2', name: 'Hospital B' },
                ],
            };
            mockGet.mockResolvedValue(paginatedResponse);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });

            expect(Array.isArray(result.current.tenants)).toBe(true);
            expect(result.current.tenants).toHaveLength(2);
        });

        it('should set empty array when response is empty', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });

            expect(result.current.tenants).toEqual([]);
            expect(result.current.tenants).toHaveLength(0);
        });
    });

    describe('get', () => {
        it('should GET from TENANT_ENDPOINTS.GET(id) and set currentTenant', async () => {
            const tenant = { id: 't-1', name: 'Clinic A', codeName: 'clinic-a' };
            mockGet.mockResolvedValue(tenant);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.GET('t-1'));
            expect(result.current.currentTenant).toEqual(tenant);
            expect(resp).toEqual(tenant);
        });
    });

    describe('getByCodeName', () => {
        it('should GET from TENANT_ENDPOINTS.GET_BY_CODE_NAME(codeName)', async () => {
            const tenant = { id: 't-1', name: 'Clinic A', codeName: 'clinic-a' };
            mockGet.mockResolvedValue(tenant);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByCodeName('clinic-a'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.GET_BY_CODE_NAME('clinic-a'));
            expect(result.current.currentTenant).toEqual(tenant);
            expect(resp).toEqual(tenant);
        });
    });

    describe('create', () => {
        it('should POST to TENANT_ENDPOINTS.CREATE with input data', async () => {
            const input = { name: 'New Clinic', codeName: 'new-clinic' };
            const created = { id: 't-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(TENANT_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should send key field to API when provided', async () => {
            const input = { name: 'New Clinic', key: 'new-clinic-key' };
            const created = { id: 't-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(
                TENANT_ENDPOINTS.CREATE,
                expect.objectContaining({ key: 'new-clinic-key' }),
            );
        });

        it('should add created tenant to tenants array', async () => {
            const existing = [{ id: 't-1', name: 'Existing' }];
            const created = { id: 't-new', name: 'New Clinic' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ name: 'New Clinic' }); });

            expect(result.current.tenants).toEqual([...existing, created]);
        });
    });

    describe('update', () => {
        // `PATCH admin/tenants/:id` is `@RequiresIfMatch()`, so
        // `update` reads the row's ETag and replays it as `If-Match` via
        // `patchWithIfMatch` (getWithEtag→patchWithIfMatch) rather than a plain PATCH
        // that would 428 live.
        it('should read the ETag and PATCH with If-Match to TENANT_ENDPOINTS.UPDATE(id)', async () => {
            const updated = { id: 't-1', name: 'Updated Clinic' };
            mockGetWithEtag.mockResolvedValue({ body: { id: 't-1', name: 'Clinic A' }, etag: '"3"' });
            mockPatchWithIfMatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('t-1', { name: 'Updated Clinic' });
            });

            expect(mockGetWithEtag).toHaveBeenCalledWith(TENANT_ENDPOINTS.GET('t-1'));
            expect(mockPatchWithIfMatch).toHaveBeenCalledWith(TENANT_ENDPOINTS.UPDATE('t-1'), { name: 'Updated Clinic' }, '"3"');
            expect(mockPatch).not.toHaveBeenCalled();
            expect(result.current.currentTenant).toEqual(updated);
            expect(resp).toEqual(updated);
        });

        it('should fall back to a plain PATCH when the row exposes no ETag', async () => {
            const updated = { id: 't-1', name: 'Updated Clinic' };
            mockGetWithEtag.mockResolvedValue({ body: { id: 't-1', name: 'Clinic A' }, etag: undefined });
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('t-1', { name: 'Updated Clinic' });
            });

            expect(mockPatchWithIfMatch).not.toHaveBeenCalled();
            expect(mockPatch).toHaveBeenCalledWith(TENANT_ENDPOINTS.UPDATE('t-1'), { name: 'Updated Clinic' });
            expect(resp).toEqual(updated);
        });

        it('should replace matching tenant in tenants array', async () => {
            const initial = [
                { id: 't-1', name: 'Clinic A' },
                { id: 't-2', name: 'Hospital B' },
            ];
            const updated = { id: 't-1', name: 'Updated Clinic' };
            mockGet.mockResolvedValue(initial);
            mockGetWithEtag.mockResolvedValue({ body: initial[0], etag: '"1"' });
            mockPatchWithIfMatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.update('t-1', { name: 'Updated Clinic' }); });

            expect(result.current.tenants).toEqual([updated, initial[1]]);
        });
    });

    describe('remove', () => {
        it('should DELETE from TENANT_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.remove('t-1'); });

            expect(mockDelete).toHaveBeenCalledWith(TENANT_ENDPOINTS.DELETE('t-1'));
        });

        it('should remove tenant from tenants array', async () => {
            const initial = [
                { id: 't-1', name: 'Clinic A' },
                { id: 't-2', name: 'Hospital B' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('t-1'); });

            expect(result.current.tenants).toEqual([initial[1]]);
        });
    });

    describe('getConfigs', () => {
        it('should GET from TENANT_ENDPOINTS.GET_CONFIGS(identifier)', async () => {
            const configs = [
                { key: 'theme', value: 'dark', dataType: 'STRING' },
                { key: 'maxUsers', value: '100', dataType: 'NUMBER' },
            ];
            mockGet.mockResolvedValue(configs);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.getConfigs('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.GET_CONFIGS('t-1'));
            expect(resp).toEqual(configs);
        });
    });

    describe('updateConfigs', () => {
        it('should PATCH to TENANT_ENDPOINTS.UPDATE_CONFIGS(identifier) with data', async () => {
            const configUpdate = { settings: [{ key: 'theme', value: 'light' }] };
            const updated = { success: true };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.updateConfigs('t-1', configUpdate); });

            expect(mockPatch).toHaveBeenCalledWith(TENANT_ENDPOINTS.UPDATE_CONFIGS('t-1'), configUpdate);
            expect(resp).toEqual(updated);
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when list is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useTenants());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when get is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useTenants());

            await expect(
                act(async () => { await result.current.get('t-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('enable', () => {
        it('should PATCH with resourceStatus ENABLED', async () => {
            const enabled = { id: 't-1', name: 'Clinic', resourceStatus: 'ENABLED' };
            mockPatch.mockResolvedValue(enabled);
            mockGet.mockResolvedValue([enabled]);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.enable('t-1'); });

            expect(mockPatch).toHaveBeenCalledWith(
                TENANT_ENDPOINTS.UPDATE('t-1'),
                { resourceStatus: 'ENABLED' },
            );
            expect(resp).toEqual(enabled);
        });

        it('should refresh the tenant list after enabling', async () => {
            const refreshed = [
                { id: 't-1', name: 'Clinic', resourceStatus: 'ENABLED' },
                { id: 't-2', name: 'Hospital', resourceStatus: 'ENABLED' },
            ];
            mockPatch.mockResolvedValue(refreshed[0]);
            mockGet.mockResolvedValue(refreshed);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.enable('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.LIST);
            expect(result.current.tenants).toEqual(refreshed);
        });

        it('should handle errors gracefully without crashing', async () => {
            mockPatch.mockRejectedValue(new Error('Network error'));
            const { result } = renderHook(() => useTenants());

            await act(async () => {
                try { await result.current.enable('t-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Network error');
            expect(result.current.isLoading).toBe(false);
        });

        it('should work on already-enabled tenant', async () => {
            const alreadyEnabled = { id: 't-1', name: 'Clinic', resourceStatus: 'ENABLED' };
            mockPatch.mockResolvedValue(alreadyEnabled);
            mockGet.mockResolvedValue([alreadyEnabled]);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.enable('t-1'); });

            expect(mockPatch).toHaveBeenCalledWith(
                TENANT_ENDPOINTS.UPDATE('t-1'),
                { resourceStatus: 'ENABLED' },
            );
            expect(resp).toEqual(alreadyEnabled);
        });
    });

    describe('disable', () => {
        it('should PATCH with resourceStatus DISABLED', async () => {
            const disabled = { id: 't-1', name: 'Clinic', resourceStatus: 'DISABLED' };
            mockPatch.mockResolvedValue(disabled);
            mockGet.mockResolvedValue([disabled]);
            const { result } = renderHook(() => useTenants());

            let resp: unknown;
            await act(async () => { resp = await result.current.disable('t-1'); });

            expect(mockPatch).toHaveBeenCalledWith(
                TENANT_ENDPOINTS.UPDATE('t-1'),
                { resourceStatus: 'DISABLED' },
            );
            expect(resp).toEqual(disabled);
        });

        it('should refresh the tenant list after disabling', async () => {
            const refreshed = [
                { id: 't-1', name: 'Clinic', resourceStatus: 'DISABLED' },
                { id: 't-2', name: 'Hospital', resourceStatus: 'ENABLED' },
            ];
            mockPatch.mockResolvedValue(refreshed[0]);
            mockGet.mockResolvedValue(refreshed);
            const { result } = renderHook(() => useTenants());

            await act(async () => { await result.current.disable('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_ENDPOINTS.LIST);
            expect(result.current.tenants).toEqual(refreshed);
        });

        it('should handle errors gracefully without crashing', async () => {
            mockPatch.mockRejectedValue(new Error('Forbidden'));
            const { result } = renderHook(() => useTenants());

            await act(async () => {
                try { await result.current.disable('t-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Forbidden');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([{ id: 't-1', name: 'Clinic' }]);
            const { result } = renderHook(() => useTenants());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fetch failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });
});
