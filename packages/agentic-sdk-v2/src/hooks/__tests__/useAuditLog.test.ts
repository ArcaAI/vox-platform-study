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
    const mockGetCsv = vi.fn();
    const mockGetBlob = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockGetCsv.mockReset();
        mockGetBlob.mockReset();

        mockStore = {
            apiClient: { get: mockGet, getCsv: mockGetCsv, getBlob: mockGetBlob, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

        it('should return an initial count of 0 (doc-03)', () => {
            const { result } = renderHook(() => useAuditLog());
            expect(result.current.count).toBe(0);
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

        it('should push from/to/action/resourceType/userId filters into the query', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useAuditLog());

            await act(async () => {
                await result.current.list({
                    page: 1,
                    limit: 10,
                    from: '2026-01-01T00:00:00.000Z',
                    to: '2026-01-31T23:59:59.999Z',
                    action: 'UPDATE',
                    resourceType: 'Consultation',
                    userId: 'user-xyz',
                });
            });

            const calledUrl = mockGet.mock.calls[0][0] as string;
            expect(calledUrl.startsWith(`${AUDIT_LOG_ENDPOINTS.LIST}?`)).toBe(true);
            expect(calledUrl).toContain('from=2026-01-01T00%3A00%3A00.000Z');
            expect(calledUrl).toContain('to=2026-01-31T23%3A59%3A59.999Z');
            expect(calledUrl).toContain('action=UPDATE');
            expect(calledUrl).toContain('resourceType=Consultation');
            expect(calledUrl).toContain('userId=user-xyz');
            expect(calledUrl).toContain('page=1');
            expect(calledUrl).toContain('limit=10');
        });

        it('should extract array from paginated wrapper response', async () => {
            const entries = [{ id: 'al-1', resourceType: 'Role', action: 'CREATE' }];
            mockGet.mockResolvedValue({ data: entries, total: 1 });
            const { result } = renderHook(() => useAuditLog());

            await act(async () => { await result.current.list(); });

            expect(result.current.entries).toEqual(entries);
        });

        it('should surface the paginated envelope count while keeping the array return shape (doc-03)', async () => {
            const entries = [
                { id: 'al-1', resourceType: 'Role', action: 'CREATE' },
                { id: 'al-2', resourceType: 'Policy', action: 'UPDATE' },
            ];
            mockGet.mockResolvedValue({ data: entries, count: 137, limit: 25, page: 1 });
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.list({ page: 1, limit: 25 }); });

            // Existing callers still receive the bare array …
            expect(Array.isArray(resp)).toBe(true);
            expect(resp).toEqual(entries);
            expect(result.current.entries).toEqual(entries);
            // … and the real total is now exposed for true pagination.
            expect(result.current.count).toBe(137);
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

    describe('getById', () => {
        it('should GET from AUDIT_LOG_ENDPOINTS.GET(id)', async () => {
            const entry = { id: 'al-1', resourceType: 'Role', action: 'CREATE', data: { name: 'Admin' } };
            mockGet.mockResolvedValue(entry);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.getById('al-1'); });

            expect(mockGet).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.GET('al-1'));
            expect(resp).toEqual(entry);
        });
    });

    describe('exportCsv', () => {
        it('should call getCsv on the EXPORT endpoint and return the CSV text', async () => {
            const csv = 'id,createdAt,action\nal-1,2026-02-01T10:00:00.000Z,CREATE';
            mockGetCsv.mockResolvedValue(csv);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.exportCsv({ action: 'CREATE' }); });

            expect(mockGetCsv).toHaveBeenCalledTimes(1);
            const calledUrl = mockGetCsv.mock.calls[0][0] as string;
            expect(calledUrl.startsWith(`${AUDIT_LOG_ENDPOINTS.EXPORT}?`)).toBe(true);
            expect(calledUrl).toContain('action=CREATE');
            expect(resp).toBe(csv);
        });

        it('should hit the bare EXPORT endpoint when no filters are given', async () => {
            mockGetCsv.mockResolvedValue('id\n');
            const { result } = renderHook(() => useAuditLog());

            await act(async () => { await result.current.exportCsv(); });

            expect(mockGetCsv).toHaveBeenCalledWith(AUDIT_LOG_ENDPOINTS.EXPORT);
        });
    });

    describe('exportFile', () => {
        it('getBlob on the EXPORT endpoint with format=xlsx (+ filters) and returns the Blob', async () => {
            const blob = new Blob(['x'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            mockGetBlob.mockResolvedValue(blob);
            const { result } = renderHook(() => useAuditLog());

            let resp: unknown;
            await act(async () => { resp = await result.current.exportFile('xlsx', { action: 'CREATE' }); });

            expect(mockGetBlob).toHaveBeenCalledTimes(1);
            const calledUrl = mockGetBlob.mock.calls[0][0] as string;
            expect(calledUrl.startsWith(`${AUDIT_LOG_ENDPOINTS.EXPORT}?`)).toBe(true);
            expect(calledUrl).toContain('format=xlsx');
            expect(calledUrl).toContain('action=CREATE');
            expect(resp).toBe(blob);
        });

        it('passes format=pdf through to getBlob', async () => {
            const blob = new Blob(['%PDF'], { type: 'application/pdf' });
            mockGetBlob.mockResolvedValue(blob);
            const { result } = renderHook(() => useAuditLog());

            await act(async () => { await result.current.exportFile('pdf'); });

            const calledUrl = mockGetBlob.mock.calls[0][0] as string;
            expect(calledUrl).toContain('format=pdf');
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
