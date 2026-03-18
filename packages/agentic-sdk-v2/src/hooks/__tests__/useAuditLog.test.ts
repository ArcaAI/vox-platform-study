/**
 * useAuditLog Hook Tests (QA-003)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuditLog } from '../useAuditLog';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { AUDIT_LOG_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAuditLog', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty entries array', () => {
            const { result } = renderHook(() => useAuditLog());
            expect(result.current.entries).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from AUDIT_LOG_ENDPOINTS.LIST and update state', async () => {
            const entries = [
                { id: 'al-1', resourceType: 'Role', action: 'CREATE', resourceId: 'r-1', createdAt: '2026-02-24T10:00:00Z' },
                { id: 'al-2', resourceType: 'Policy', action: 'UPDATE', resourceId: 'p-1', createdAt: '2026-02-24T11:00:00Z' },
            ];
            mockGet.mockResolvedValue(entries);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.LIST);
            expect(result.current.entries).toEqual(entries);
            expect(resp).toEqual(entries);
        });

        it('should pass pagination params', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useAuditLog());

            await act(async () => {
                await result.current.list({ page: 2, limit: 20 });
            });

            expect(mockGet).toHaveBeenCalledWith(`${AUDIT_LOG_ENDPOINTS.LIST}?page=2&limit=20`);
        });

        it('should extract array from paginated wrapper response', async () => {
            const entries = [{ id: 'al-1', resourceType: 'Role', action: 'CREATE' }];
            mockGet.mockResolvedValue({ data: entries, total: 1 });
            const { result } = renderHook(() => useAuditLog());

            await act(async () => { await result.current.list(); });

            expect(result.current.entries).toEqual(entries);
        });

        it('should return empty array for unexpected response shape', async () => {
            mockGet.mockResolvedValue({ error: 'forbidden' });
            const { result } = renderHook(() => useAuditLog());

            await act(async () => { await result.current.list(); });

            expect(result.current.entries).toEqual([]);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Unauthorized'));
            const { result } = renderHook(() => useAuditLog());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Unauthorized');
        });
    });

    describe('get', () => {
        it('should GET from AUDIT_LOG_ENDPOINTS.GET(id)', async () => {
            const entry = { id: 'al-1', resourceType: 'Role', action: 'CREATE', data: { name: 'Admin' } };
            mockGet.mockResolvedValue(entry);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('al-1'); });

            expect(mockGet).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.GET('al-1'));
            expect(resp).toEqual(entry);
        });
    });

    describe('byResource', () => {
        it('should GET from AUDIT_LOG_ENDPOINTS.BY_RESOURCE', async () => {
            const entries = [
                { id: 'al-1', resourceType: 'Role', resourceId: 'r-1', action: 'CREATE' },
            ];
            mockGet.mockResolvedValue(entries);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.byResource('Role', 'r-1'); });

            expect(mockGet).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.BY_RESOURCE('Role', 'r-1'));
            expect(resp).toEqual(entries);
        });

        it('should extract array from wrapped response', async () => {
            const entries = [{ id: 'al-1' }];
            mockGet.mockResolvedValue({ data: entries });
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.byResource('Policy', 'p-1'); });

            expect(resp).toEqual(entries);
        });
    });

    describe('byUser', () => {
        it('should GET from AUDIT_LOG_ENDPOINTS.BY_USER', async () => {
            const entries = [
                { id: 'al-1', responsibleUserId: 'u-1', action: 'CREATE' },
            ];
            mockGet.mockResolvedValue(entries);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.byUser('u-1'); });

            expect(mockGet).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.BY_USER('u-1'));
            expect(resp).toEqual(entries);
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useAuditLog());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Failed')).mockResolvedValueOnce([]);
            const { result } = renderHook(() => useAuditLog());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });
});
