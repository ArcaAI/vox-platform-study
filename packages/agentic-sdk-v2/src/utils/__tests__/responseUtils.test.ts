/**
 * responseUtils Tests (TASK-215)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { extractArray, extractCursorPaginated } from '../responseUtils';
import { DEFAULT_PAGE_SIZE } from '../../types/common';

describe('extractArray', () => {
    it('should return the array when response is already an array', () => {
        const arr = [{ id: '1' }, { id: '2' }];
        expect(extractArray(arr)).toEqual(arr);
    });

    it('should extract data array from paginated response', () => {
        const paginated = {
            count: 2,
            limit: 10,
            page: 1,
            data: [{ id: '1' }, { id: '2' }],
        };
        expect(extractArray(paginated)).toEqual(paginated.data);
    });

    it('should return empty array for null', () => {
        expect(extractArray(null)).toEqual([]);
    });

    it('should return empty array for undefined', () => {
        expect(extractArray(undefined)).toEqual([]);
    });

    it('should return empty array for a plain object without data', () => {
        expect(extractArray({ count: 0, page: 1 })).toEqual([]);
    });

    it('should return empty array for a string', () => {
        expect(extractArray('not an array' as any)).toEqual([]);
    });

    it('should return empty array for a number', () => {
        expect(extractArray(42 as any)).toEqual([]);
    });

    it('should return empty array when data property is not an array', () => {
        expect(extractArray({ data: 'string' })).toEqual([]);
    });

    it('should handle empty array response', () => {
        expect(extractArray([])).toEqual([]);
    });

    it('should handle paginated response with empty data array', () => {
        expect(extractArray({ count: 0, data: [] })).toEqual([]);
    });

    it('should extract items array from { items: [...] } wrapper', () => {
        const wrapper = { items: [{ id: '1' }, { id: '2' }], total: 2, page: 1 };
        expect(extractArray(wrapper)).toEqual(wrapper.items);
    });

    it('should extract results array from { results: [...] } wrapper', () => {
        const wrapper = { results: [{ id: '1' }], count: 1 };
        expect(extractArray(wrapper)).toEqual(wrapper.results);
    });

    it('should prefer data over items when both exist', () => {
        const wrapper = { data: [{ id: 'from-data' }], items: [{ id: 'from-items' }] };
        expect(extractArray(wrapper)).toEqual([{ id: 'from-data' }]);
    });

    it('should fall back to items when data is not an array', () => {
        const wrapper = { data: 'not-array', items: [{ id: '1' }] };
        expect(extractArray(wrapper)).toEqual([{ id: '1' }]);
    });

    it('should fall back to results when data and items are not arrays', () => {
        const wrapper = { data: null, items: 'nope', results: [{ id: '1' }] };
        expect(extractArray(wrapper)).toEqual([{ id: '1' }]);
    });

    it('should return empty array when data, items, and results are all non-arrays', () => {
        expect(extractArray({ data: 'x', items: 42, results: false })).toEqual([]);
    });

    it('should handle { items: [] } with empty array', () => {
        expect(extractArray({ items: [], total: 0 })).toEqual([]);
    });

    it('should handle { results: [] } with empty array', () => {
        expect(extractArray({ results: [] })).toEqual([]);
    });

    it('should handle RBAC-style wrapper with total and pageSize', () => {
        const rbac = { data: [{ id: 'r-1', name: 'Admin' }], total: 1, page: 1, pageSize: 10 };
        expect(extractArray(rbac)).toEqual(rbac.data);
    });
});

// TASK-373 client follow-up — cursor (keyset) normalizer. Maps the server
// `CursorPaginatedResponse<T>` (`{ data, nextCursor, hasMore, limit }`, from
// `GET /admin/audit-logs/cursor`) into the client `PageResult<T>` cursor shape
// (`@arcaai/ui` `lib/shared/pagination.ts`): `{ rows, nextCursor, hasMore, limit }`.
describe('extractCursorPaginated', () => {
    it('maps a server cursor response { data, nextCursor, hasMore, limit } to the client page shape', () => {
        const raw = {
            data: [{ id: 'a-1' }, { id: 'a-2' }],
            nextCursor: 'eyJrIjoiMjAyNiIsImlkIjoiYS0yIn0',
            hasMore: true,
            limit: 2,
        };
        expect(extractCursorPaginated(raw)).toEqual({
            rows: [{ id: 'a-1' }, { id: 'a-2' }],
            nextCursor: 'eyJrIjoiMjAyNiIsImlkIjoiYS0yIn0',
            hasMore: true,
            limit: 2,
        });
    });

    it('reads rows from the server `data` key (not `rows`)', () => {
        const raw = { data: [{ id: 'x' }], nextCursor: null, hasMore: false, limit: 10 };
        const result = extractCursorPaginated<{ id: string }>(raw);
        expect(result.rows).toEqual([{ id: 'x' }]);
    });

    it('preserves nextCursor=null and hasMore=false on the last page', () => {
        const raw = { data: [{ id: 'last' }], nextCursor: null, hasMore: false, limit: 10 };
        const result = extractCursorPaginated(raw);
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
    });

    it('derives hasMore from nextCursor when hasMore is absent', () => {
        const raw = { data: [{ id: '1' }], nextCursor: 'cursor-token', limit: 10 };
        const result = extractCursorPaginated(raw);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe('cursor-token');
    });

    it('defaults hasMore to false when neither hasMore nor nextCursor are present', () => {
        const raw = { data: [{ id: '1' }], limit: 10 };
        const result = extractCursorPaginated(raw);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
    });

    it('falls back to DEFAULT_PAGE_SIZE when limit is missing or invalid', () => {
        expect(extractCursorPaginated({ data: [] }).limit).toBe(DEFAULT_PAGE_SIZE);
        expect(extractCursorPaginated({ data: [], limit: 0 }).limit).toBe(DEFAULT_PAGE_SIZE);
        expect(extractCursorPaginated({ data: [], limit: -5 }).limit).toBe(DEFAULT_PAGE_SIZE);
    });

    it('handles an empty data array', () => {
        expect(extractCursorPaginated({ data: [], nextCursor: null, hasMore: false, limit: 20 })).toEqual({
            rows: [],
            nextCursor: null,
            hasMore: false,
            limit: 20,
        });
    });

    it('returns safe defaults for null/undefined/non-object input', () => {
        const expected = { rows: [], nextCursor: null, hasMore: false, limit: DEFAULT_PAGE_SIZE };
        expect(extractCursorPaginated(null)).toEqual(expected);
        expect(extractCursorPaginated(undefined)).toEqual(expected);
        expect(extractCursorPaginated('nope' as unknown)).toEqual(expected);
    });

    it('coerces a non-string nextCursor to null', () => {
        const raw = { data: [{ id: '1' }], nextCursor: 123 as unknown, hasMore: true, limit: 10 };
        expect(extractCursorPaginated(raw).nextCursor).toBeNull();
    });
});
