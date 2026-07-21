/**
 * useGlobalSettings Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGlobalSettings } from '../useGlobalSettings';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { GLOBAL_SETTINGS_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useGlobalSettings', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockGetWithEtag = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockPatchWithIfMatch = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockGetWithEtag.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockPatchWithIfMatch.mockReset();
        mockDelete.mockReset();

        // `get` and `update` now flow through
        // `getWithEtag`/`patchWithIfMatch` (D.4). Pre-existing tests below
        // are migrated to the new mocks; the `mockGet`/`mockPatch` keys
        // are kept for `list`/`getByTenant`/`getTenantConfig`/`create`
        // which still use the bare `get`/`post` paths.
        mockStore = {
            apiClient: {
                get: mockGet,
                getWithEtag: mockGetWithEtag,
                post: mockPost,
                patch: mockPatch,
                patchWithIfMatch: mockPatchWithIfMatch,
                delete: mockDelete,
            },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty settings arrays', () => {
            const { result } = renderHook(() => useGlobalSettings());
            expect(result.current.settings).toEqual([]);
            expect(result.current.tenantConfig).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from GLOBAL_SETTINGS_ENDPOINTS.LIST and update state', async () => {
            const data = [
                { id: 'gs-1', key: 'stt.model', value: 'whisper-large', tenantId: 't-1' },
                { id: 'gs-2', key: 'smr.model', value: 'gpt-4', tenantId: 't-1' },
            ];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.LIST);
            expect(result.current.settings).toEqual(data);
            expect(resp).toEqual(data);
        });

        it('should pass pagination params as query string', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list({ page: 2, limit: 10 }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('page=2'));
            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('limit=10'));
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Forbidden'));
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Forbidden');
            expect(result.current.isLoading).toBe(false);
        });

        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            mockGet.mockResolvedValue({ data: items, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });

            expect(result.current.settings).toEqual(items);
            expect(Array.isArray(result.current.settings)).toBe(true);
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ message: 'no settings' });
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });

            expect(result.current.settings).toEqual([]);
        });
    });

    describe('getByTenant', () => {
        it('should GET from GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT', async () => {
            const data = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByTenant('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining(GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT('t-1')));
            expect(resp).toEqual(data);
        });
    });

    describe('getByTenant paginated', () => {
        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            mockGet.mockResolvedValue({ data: items, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByTenant('t-1'); });

            expect(resp).toEqual(items);
            expect(Array.isArray(resp)).toBe(true);
        });
    });

    describe('getTenantConfig', () => {
        it('should GET from GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG and update tenantConfig', async () => {
            const data = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.getTenantConfig('t-1'); });

            expect(mockGet).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG('t-1'));
            expect(result.current.tenantConfig).toEqual(data);
            expect(resp).toEqual(data);
        });
    });

    describe('getTenantConfig paginated', () => {
        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            mockGet.mockResolvedValue({ data: items, count: 1 });
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.getTenantConfig('t-1'); });

            expect(result.current.tenantConfig).toEqual(items);
            expect(Array.isArray(result.current.tenantConfig)).toBe(true);
        });
    });

    describe('get', () => {
        it('should GET from GLOBAL_SETTINGS_ENDPOINTS.GET(id)', async () => {
            // `get` now calls `getWithEtag` to
            // capture the ETag for a follow-up `update`. The body return
            // shape is preserved (backwards-compatible for callers that
            // only read `result.current.get(id)`'s resolved value).
            const setting = { id: 'gs-bg1', key: 'stt.model', value: 'whisper', tenantId: 't-1', version: 1 };
            mockGetWithEtag.mockResolvedValue({ body: setting, etag: '"1"' });
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('gs-bg1'); });

            expect(mockGetWithEtag).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.GET('gs-bg1'));
            expect(resp).toEqual(setting);
        });
    });

    describe('create', () => {
        it('should POST to GLOBAL_SETTINGS_ENDPOINTS.CREATE', async () => {
            const created = { id: 'gs-3', key: 'new.setting', value: 'val', tenantId: 't-1' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.create({ key: 'new.setting', value: 'val' }); });

            expect(mockPost).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.CREATE, { key: 'new.setting', value: 'val' });
            expect(resp).toEqual(created);
        });

        it('should include name, dataType, namespace, and tenantId when provided', async () => {
            const input = {
                key: 'stt.provider',
                name: 'STT Provider',
                value: 'whisper',
                dataType: 'String',
                namespace: 'audio',
                tenantId: 'tenant-1',
            };
            const created = { id: 'gs-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created setting to settings array', async () => {
            const existing = [{ id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' }];
            const created = { id: 'gs-new', key: 'new.key', value: 'new-val', tenantId: 't-1' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ key: 'new.key', value: 'new-val' }); });

            expect(result.current.settings).toEqual([...existing, created]);
        });
    });

    describe('update', () => {
        it('should PATCH to GLOBAL_SETTINGS_ENDPOINTS.UPDATE(id) with cached If-Match', async () => {
            // `update` requires a prior `get`
            // to populate the ETag cache. The PATCH path now flows
            // through `patchWithIfMatch` (not bare `patch`).
            const FRESH_ID = 'gs-update-bg-7c9d4e';
            const fetched = { id: FRESH_ID, key: 'stt.model', value: 'whisper', tenantId: 't-1', version: 1 };
            const updated = { id: FRESH_ID, key: 'stt.model', value: 'whisper-v3', tenantId: 't-1', version: 2 };
            mockGetWithEtag.mockResolvedValue({ body: fetched, etag: '"1"' });
            mockPatchWithIfMatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.get(FRESH_ID); });

            let resp: unknown;
            await act(async () => { resp = await result.current.update(FRESH_ID, { value: 'whisper-v3' }); });

            expect(mockPatchWithIfMatch).toHaveBeenCalledWith(
                GLOBAL_SETTINGS_ENDPOINTS.UPDATE(FRESH_ID),
                { value: 'whisper-v3' },
                '"1"',
            );
            expect(resp).toEqual(updated);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-006: remove tests                                               */
    /* ------------------------------------------------------------------ */

    describe('remove (QA-006)', () => {
        it('should DELETE the setting', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.remove('gs-1'); });

            expect(mockDelete).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.DELETE('gs-1'));
        });

        it('should remove from local state', async () => {
            const initial = [
                { id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' },
                { id: 'gs-2', key: 'smr.model', value: 'gpt-4', tenantId: 't-1' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });
            expect(result.current.settings).toHaveLength(2);

            await act(async () => { await result.current.remove('gs-1'); });

            expect(result.current.settings).toEqual([initial[1]]);
            expect(result.current.settings).toHaveLength(1);
        });

        it('should handle remove on non-existent setting without crashing', async () => {
            const initial = [
                { id: 'gs-1', key: 'stt.model', value: 'whisper', tenantId: 't-1' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('gs-nonexistent'); });

            expect(result.current.settings).toEqual(initial);
        });

        it('should handle API error on remove', async () => {
            mockDelete.mockRejectedValue(new Error('Not found'));
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                try { await result.current.remove('gs-bad'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Not found');
            expect(result.current.isLoading).toBe(false);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  revealSecret (global-admin, step-up re-auth)              */
    /* ------------------------------------------------------------------ */

    describe('revealSecret (TASK-396)', () => {
        it('should POST the password to GLOBAL_SETTINGS_ENDPOINTS.REVEAL(id) and return the plaintext payload', async () => {
            const payload = { id: 'gs-secret-1', key: 'secrets.api-token', value: 'super-secret-plaintext', revealedAt: '2026-07-02T00:00:00.000Z' };
            mockPost.mockResolvedValue(payload);
            const { result } = renderHook(() => useGlobalSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.revealSecret('gs-secret-1', { password: 'password123' }); });

            expect(mockPost).toHaveBeenCalledWith(GLOBAL_SETTINGS_ENDPOINTS.REVEAL('gs-secret-1'), { password: 'password123' });
            expect(resp).toEqual(payload);
        });

        it('should NOT persist the revealed plaintext into settings state (transient)', async () => {
            const existing = [{ id: 'gs-secret-1', key: 'secrets.api-token', value: '', tenantId: 't-1', isSecret: true }];
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue({ id: 'gs-secret-1', key: 'secrets.api-token', value: 'plaintext', revealedAt: '2026-07-02T00:00:00.000Z' });
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.revealSecret('gs-secret-1', { password: 'password123' }); });

            // The masked row is untouched — the plaintext never leaks into state.
            expect(result.current.settings).toEqual(existing);
        });

        it('should surface a wrong/absent-password rejection as an error (401)', async () => {
            mockPost.mockRejectedValue(new Error('Unauthorized'));
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => {
                try { await result.current.revealSecret('gs-secret-1', { password: 'wrong' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Unauthorized');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useGlobalSettings());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('null logger', () => {
        it('should work when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useGlobalSettings());

            await act(async () => { await result.current.list(); });
            expect(result.current.settings).toEqual([]);
        });
    });
});
