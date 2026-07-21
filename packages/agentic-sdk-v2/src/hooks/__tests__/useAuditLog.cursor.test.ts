/**
 * useAuditLog().listByCursor — cursor (keyset) audit-log query
 *
 * First-class SDK sibling of the offset `list()`. Calls
 * `GET /admin/audit-logs/cursor` with `cursor` + `limit` + the SAME A8 filters
 * the offset path supports (`from`/`to`/`action`/`resourceType`/`userId`), then
 * returns the server `CursorPaginatedResponse<T>` (`{ data, nextCursor, hasMore,
 * limit }`) normalized via `extractCursorPaginated` into the client
 * `PageResult<T>`-shaped cursor page (`{ rows, nextCursor, hasMore, limit }`).
 *
 * This removes the need for `apps/admin` to keep a local cursor PATH constant and
 * call the raw `apiClient`. Back-compat: the offset `list()` is unchanged.
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

const CURSOR_ENVELOPE = { data: [] as unknown[], nextCursor: null, hasMore: false, limit: 10 };

describe('useAuditLog().listByCursor — cursor query forwarding', () => {
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockGet.mockReset().mockResolvedValue(CURSOR_ENVELOPE);
        mockStore = {
            apiClient: { get: mockGet, getCsv: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
            logger: createMockLogger(),
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    function calledUrl(): string {
        expect(mockGet).toHaveBeenCalledTimes(1);
        return mockGet.mock.calls[0][0] as string;
    }

    // ---- endpoint path present ---------------------------------------------

    it('exposes the cursor endpoint path constant', () => {
        expect(AUDIT_LOG_ENDPOINTS.CURSOR).toBe('/admin/audit-logs/cursor');
    });

    // ---- URL building (cursor + limit + filters) ---------------------------

    it('hits the cursor endpoint with a default limit when called with no arguments', async () => {
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor();
        });
        const url = calledUrl();
        expect(url.startsWith(`${AUDIT_LOG_ENDPOINTS.CURSOR}?`)).toBe(true);
        expect(url).toContain('limit=10');
        expect(url).not.toContain('cursor=');
    });

    it('forwards the limit', async () => {
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor({ limit: 25 });
        });
        expect(calledUrl()).toContain('limit=25');
    });

    it('forwards the cursor token when paging forward', async () => {
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor({ cursor: 'eyJrIjoiMjAyNiJ9', limit: 10 });
        });
        expect(calledUrl()).toContain('cursor=eyJrIjoiMjAyNiJ9');
    });

    it('omits the cursor on the first page (cursor null)', async () => {
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor({ cursor: null, limit: 10 });
        });
        expect(calledUrl()).not.toContain('cursor=');
    });

    it('pushes the same A8 filters the offset path supports, as one query string', async () => {
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor({
                cursor: 'tok',
                limit: 20,
                from: '2026-01-01T00:00:00.000Z',
                to: '2026-01-31T23:59:59.999Z',
                action: 'UPDATE',
                resourceType: 'Consultation',
                userId: 'user-xyz',
            });
        });
        const url = calledUrl();
        const decoded = decodeURIComponent(url);
        expect(url.split('?').length).toBe(2); // exactly one '?'
        expect(url).toContain('cursor=tok');
        expect(url).toContain('limit=20');
        expect(decoded).toContain('from=2026-01-01T00:00:00.000Z');
        expect(decoded).toContain('to=2026-01-31T23:59:59.999Z');
        expect(url).toContain('action=UPDATE');
        expect(url).toContain('resourceType=Consultation');
        expect(url).toContain('userId=user-xyz');
    });

    // ---- normalization via extractCursorPaginated --------------------------

    it('normalizes the server CursorPaginatedResponse into the client cursor page', async () => {
        mockGet.mockResolvedValueOnce({
            data: [{ id: 'al-1' }, { id: 'al-2' }],
            nextCursor: 'next-tok',
            hasMore: true,
            limit: 2,
        });
        const { result } = renderHook(() => useAuditLog());
        let resp: any;
        await act(async () => {
            resp = await result.current.listByCursor({ limit: 2 });
        });
        expect(resp).toEqual({
            rows: [{ id: 'al-1' }, { id: 'al-2' }],
            nextCursor: 'next-tok',
            hasMore: true,
            limit: 2,
        });
    });

    it('returns a PageResult-shaped cursor page (rows, nextCursor, hasMore, limit)', async () => {
        const { result } = renderHook(() => useAuditLog());
        let resp: any;
        await act(async () => {
            resp = await result.current.listByCursor();
        });
        expect(resp).toHaveProperty('rows');
        expect(resp).toHaveProperty('nextCursor');
        expect(resp).toHaveProperty('hasMore');
        expect(resp).toHaveProperty('limit');
        expect(Array.isArray(resp.rows)).toBe(true);
    });

    // ---- back-compat: offset state untouched -------------------------------

    it('does not mutate the offset entries/count state', async () => {
        mockGet.mockResolvedValueOnce({ data: [{ id: 'al-1' }], nextCursor: null, hasMore: false, limit: 10 });
        const { result } = renderHook(() => useAuditLog());
        await act(async () => {
            await result.current.listByCursor();
        });
        expect(result.current.entries).toEqual([]);
        expect(result.current.count).toBe(0);
    });
});
