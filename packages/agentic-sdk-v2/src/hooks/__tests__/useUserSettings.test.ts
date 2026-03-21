/**
 * useUserSettings Hook Tests (TASK-032 WS-A)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUserSettings } from '../useUserSettings';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_SETTINGS_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUserSettings', () => {
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

    describe('initial state', () => {
        it('should return empty settings and mySettings', () => {
            const { result } = renderHook(() => useUserSettings());
            expect(result.current.settings).toEqual([]);
            expect(result.current.mySettings).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from USER_SETTINGS_ENDPOINTS.LIST and update state', async () => {
            const data = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => useUserSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.LIST);
            expect(result.current.settings).toEqual(data);
            expect(resp).toEqual(data);
        });

        it('should pass pagination params', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useUserSettings());

            await act(async () => { await result.current.list({ page: 1, limit: 5 }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('page=1'));
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Forbidden'));
            const { result } = renderHook(() => useUserSettings());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Forbidden');
        });

        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
            mockGet.mockResolvedValue({ data: items, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => useUserSettings());

            await act(async () => { await result.current.list(); });

            expect(result.current.settings).toEqual(items);
            expect(Array.isArray(result.current.settings)).toBe(true);
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => useUserSettings());

            await act(async () => { await result.current.list(); });

            expect(result.current.settings).toEqual([]);
        });
    });

    describe('getMySettings', () => {
        it('should GET from USER_SETTINGS_ENDPOINTS.MY_SETTINGS and update mySettings', async () => {
            const data = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => useUserSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.getMySettings('u-1'); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining(USER_SETTINGS_ENDPOINTS.MY_SETTINGS('u-1')));
            expect(result.current.mySettings).toEqual(data);
            expect(resp).toEqual(data);
        });
    });

    describe('getMySettings paginated', () => {
        it('should extract array from paginated wrapper response', async () => {
            const items = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
            mockGet.mockResolvedValue({ data: items, count: 1 });
            const { result } = renderHook(() => useUserSettings());

            await act(async () => { await result.current.getMySettings('u-1'); });

            expect(result.current.mySettings).toEqual(items);
            expect(Array.isArray(result.current.mySettings)).toBe(true);
        });
    });

    describe('get', () => {
        it('should GET from USER_SETTINGS_ENDPOINTS.GET(id)', async () => {
            const setting = { id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' };
            mockGet.mockResolvedValue(setting);
            const { result } = renderHook(() => useUserSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('us-1'); });

            expect(mockGet).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.GET('us-1'));
            expect(resp).toEqual(setting);
        });
    });

    describe('create', () => {
        it('should POST to USER_SETTINGS_ENDPOINTS.CREATE with auto-populated name and dataType', async () => {
            const created = { id: 'us-2', key: 'lang', value: 'en', userId: 'u-1' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useUserSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.create({ key: 'lang', value: 'en' }); });

            expect(mockPost).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.CREATE, {
                key: 'lang',
                value: 'en',
                name: 'lang',
                dataType: 'String',
            });
            expect(resp).toEqual(created);
        });

        it('should use provided name and dataType when explicitly set', async () => {
            const created = { id: 'us-3', key: 'opts', value: '{}', userId: 'u-1' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useUserSettings());

            await act(async () => {
                await result.current.create({
                    key: 'opts',
                    name: 'Custom Name',
                    value: '{}',
                    dataType: 'Json',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.CREATE, {
                key: 'opts',
                name: 'Custom Name',
                value: '{}',
                dataType: 'Json',
            });
        });

        it('should auto-detect Json dataType for object values and stringify them', async () => {
            const created = { id: 'us-4', key: 'config', value: '{"a":1}', userId: 'u-1' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useUserSettings());

            await act(async () => {
                await result.current.create({ key: 'config', value: { a: 1 } });
            });

            expect(mockPost).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.CREATE, {
                key: 'config',
                name: 'config',
                value: '{"a":1}',
                dataType: 'Json',
            });
        });
    });

    describe('update', () => {
        it('should PATCH to USER_SETTINGS_ENDPOINTS.UPDATE(id)', async () => {
            const updated = { id: 'us-1', key: 'theme', value: 'light', userId: 'u-1' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUserSettings());

            let resp: unknown;
            await act(async () => { resp = await result.current.update('us-1', { value: 'light' }); });

            expect(mockPatch).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.UPDATE('us-1'), { value: 'light' });
            expect(resp).toEqual(updated);
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUserSettings());

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
            const { result } = renderHook(() => useUserSettings());

            await act(async () => { await result.current.list(); });
            expect(result.current.settings).toEqual([]);
        });
    });
});
