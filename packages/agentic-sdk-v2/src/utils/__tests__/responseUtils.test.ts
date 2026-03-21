/**
 * responseUtils Tests (TASK-215)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { extractArray } from '../responseUtils';

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
