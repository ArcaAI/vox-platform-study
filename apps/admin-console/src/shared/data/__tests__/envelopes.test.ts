import { describe, expect, it } from 'vitest';
import { normalizeList } from '../envelopes';

interface Row {
    id: string;
}

const rows: Row[] = [{ id: 'a' }, { id: 'b' }];

describe('normalizeList — envelope normalization', () => {
    it('normalizes the standard offset envelope { data, count, limit, page }', () => {
        expect(normalizeList<Row>({ data: rows, count: 42, limit: 25, page: 0 })).toEqual({
            rows,
            total: 42,
            page: 0,
            limit: 25,
            totalPages: 2,
            hasMore: true,
        });
    });

    it('normalizes { data, count, page, limit } and computes hasMore=false on the last page', () => {
        expect(normalizeList<Row>({ data: rows, count: 10, page: 1, limit: 5 })).toEqual({
            rows,
            total: 10,
            page: 1,
            limit: 5,
            totalPages: 2,
            hasMore: false,
        });
    });

    it('normalizes the SDK-style envelope { data, total, totalPages } (no page/limit)', () => {
        expect(normalizeList<Row>({ data: rows, total: 7, totalPages: 1 })).toEqual({
            rows,
            total: 7,
            totalPages: 1,
        });
    });

    it('normalizes the { data, total, page, pageSize } envelope (pageSize → limit)', () => {
        expect(normalizeList<Row>({ data: rows, total: 100, page: 2, pageSize: 20 })).toEqual({
            rows,
            total: 100,
            page: 2,
            limit: 20,
            totalPages: 5,
            hasMore: true,
        });
    });

    it('normalizes the { items, total } envelope (items → rows)', () => {
        expect(normalizeList<Row>({ items: rows, total: 3 })).toEqual({
            rows,
            total: 3,
        });
    });

    it('normalizes the cursor envelope { data, nextCursor, hasMore, limit }', () => {
        expect(normalizeList<Row>({ data: rows, nextCursor: 'abc', hasMore: true, limit: 50 })).toEqual({
            rows,
            limit: 50,
            hasMore: true,
            nextCursor: 'abc',
        });
    });

    it('treats a null nextCursor with hasMore=false as an exhausted cursor page', () => {
        expect(normalizeList<Row>({ data: [], nextCursor: null, hasMore: false, limit: 50 })).toEqual({
            rows: [],
            limit: 50,
            hasMore: false,
            nextCursor: null,
        });
    });

    it('normalizes a 1-based page envelope to the internal 0-based page via pageBase', () => {
        expect(normalizeList<Row>({ data: rows, count: 30, page: 1, limit: 10 }, { pageBase: 1 })).toEqual({
            rows,
            total: 30,
            page: 0,
            limit: 10,
            totalPages: 3,
            hasMore: true,
        });
    });

    it('is defensive: returns empty rows for a non-list payload', () => {
        expect(normalizeList<Row>({})).toEqual({ rows: [] });
        expect(normalizeList<Row>(null)).toEqual({ rows: [] });
    });
});
