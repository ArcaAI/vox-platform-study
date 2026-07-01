import type { ColumnDef } from '@tanstack/react-table';
import { describe, expect, it } from 'vitest';
import { getColumnId, paginationSummary, selectCondensedColumns } from '../responsive-grid';

type Row = { id: string; name: string; email: string; status: string };

const columns: ColumnDef<Row>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'email', header: 'Email' },
    { accessorKey: 'status', header: 'Status' },
    { id: 'actions', header: '' },
];

describe('getColumnId', () => {
    it('prefers an explicit id', () => {
        expect(getColumnId({ id: 'actions', header: '' } as ColumnDef<Row>)).toBe('actions');
    });

    it('falls back to the accessorKey', () => {
        expect(getColumnId({ accessorKey: 'email', header: 'Email' } as ColumnDef<Row>)).toBe('email');
    });

    it('returns undefined when neither is present', () => {
        expect(getColumnId({ header: 'x' } as ColumnDef<Row>)).toBeUndefined();
    });
});

describe('selectCondensedColumns', () => {
    it('keeps only the requested columns, preserving original order', () => {
        const result = selectCondensedColumns(columns, ['status', 'name']);
        expect(result.map((c) => getColumnId(c))).toEqual(['name', 'status']);
    });

    it('returns all columns when no keep list is given', () => {
        expect(selectCondensedColumns(columns)).toHaveLength(columns.length);
        expect(selectCondensedColumns(columns, [])).toHaveLength(columns.length);
    });

    it('ignores ids that do not exist', () => {
        expect(selectCondensedColumns(columns, ['name', 'nope']).map((c) => getColumnId(c))).toEqual(['name']);
    });
});

describe('paginationSummary', () => {
    it('describes the first page', () => {
        expect(paginationSummary(0, 20, 248)).toMatchObject({ from: 1, to: 20, total: 248, page: 0, pageCount: 13, canPrev: false, canNext: true });
    });

    it('describes a middle page', () => {
        expect(paginationSummary(2, 20, 248)).toMatchObject({ from: 41, to: 60, canPrev: true, canNext: true });
    });

    it('describes the last (partial) page', () => {
        expect(paginationSummary(12, 20, 248)).toMatchObject({ from: 241, to: 248, page: 12, canPrev: true, canNext: false });
    });

    it('handles an empty result set', () => {
        expect(paginationSummary(0, 20, 0)).toMatchObject({ from: 0, to: 0, total: 0, pageCount: 1, canPrev: false, canNext: false });
    });

    it('clamps an out-of-range page into bounds', () => {
        expect(paginationSummary(99, 20, 248)).toMatchObject({ page: 12, canNext: false });
    });
});
