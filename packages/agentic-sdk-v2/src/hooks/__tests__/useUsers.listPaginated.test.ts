/**
 * useUsers().listPaginated — sort/filter/search forwarding
 *
 * `listPaginated` previously only forwarded `page`/`limit`. It now forwards the
 * full backend `PaginatedQuery` contract (CSV `filters` + `sort` + `search`
 * [+ `searchFields`]), mirroring how the offset audit-log query is built
 * (`appendPagination(appendFilters(...))`). Back-compat: callers passing only
 * `page`/`limit` (or nothing) still produce the exact same URL as before.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

const PAGINATED_ENVELOPE = { data: [] as unknown[], count: 0, page: 0, limit: 20 };

describe('useUsers().listPaginated — query forwarding', () => {
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockGet.mockReset().mockResolvedValue(PAGINATED_ENVELOPE);
        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

    // ---- Back-compat (page/limit only) -------------------------------------

    it('forwards page and limit (unchanged behavior)', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ page: 2, limit: 20 });
        });
        const url = calledUrl();
        expect(url).toContain('page=2');
        expect(url).toContain('limit=20');
    });

    it('hits the bare LIST endpoint when called with no arguments (back-compat)', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated();
        });
        expect(calledUrl()).toBe(USER_ENDPOINTS.LIST);
    });

    it('does not append filter/sort/search keys when only page/limit are given', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ page: 0, limit: 10 });
        });
        const url = calledUrl();
        expect(url).not.toContain('filters=');
        expect(url).not.toContain('sort=');
        expect(url).not.toContain('search=');
    });

    // ---- New: full PaginatedQuery forwarding --------------------------------

    it('forwards search', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ page: 0, limit: 10, search: 'john' });
        });
        expect(calledUrl()).toContain('search=john');
    });

    it('forwards the CSV sort string', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ sort: 'username:asc,createdAt:desc' });
        });
        const url = calledUrl();
        // URLSearchParams encodes ':' as %3A and ',' as %2C
        expect(decodeURIComponent(url)).toContain('sort=username:asc,createdAt:desc');
    });

    it('forwards the CSV filters string', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ filters: 'resourceStatus:ENABLED,isServiceAccount:false' });
        });
        expect(decodeURIComponent(calledUrl())).toContain('filters=resourceStatus:ENABLED,isServiceAccount:false');
    });

    it('forwards searchFields', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({ searchFields: 'username,email' });
        });
        expect(decodeURIComponent(calledUrl())).toContain('searchFields=username,email');
    });

    it('forwards page, limit, search, sort, and filters together as one query string', async () => {
        const { result } = renderHook(() => useUsers());
        await act(async () => {
            await result.current.listPaginated({
                page: 1,
                limit: 50,
                search: 'jo',
                sort: 'username:asc',
                filters: 'resourceStatus:ENABLED',
            });
        });
        const url = calledUrl();
        const decoded = decodeURIComponent(url);
        expect(url.split('?').length).toBe(2); // exactly one '?'
        expect(decoded).toContain('search=jo');
        expect(decoded).toContain('sort=username:asc');
        expect(decoded).toContain('filters=resourceStatus:ENABLED');
        expect(url).toContain('page=1');
        expect(url).toContain('limit=50');
    });

    it('still returns the full paginated envelope and populates users state', async () => {
        mockGet.mockResolvedValueOnce({
            data: [{ id: 'u-1', username: 'jo' }],
            count: 1,
            page: 0,
            limit: 20,
        });
        const { result } = renderHook(() => useUsers());
        let resp: any;
        await act(async () => {
            resp = await result.current.listPaginated({ search: 'jo' });
        });
        expect(resp.data).toEqual([{ id: 'u-1', username: 'jo' }]);
        expect(resp.total).toBe(1);
        expect(result.current.users).toEqual([{ id: 'u-1', username: 'jo' }]);
    });
});
