import { describe, expect, it } from 'vitest';
import type { DataQueryState, FilterRule } from '@arcaai/ui';
import { decodeFilters, encodeFilters, gridQueryParsers, parseSearchParams, toListParams } from '../grid-url-state';

function offsetState(overrides: Partial<DataQueryState> = {}): DataQueryState {
    return {
        pagination: { mode: 'offset', page: 0, limit: 25 },
        sorting: [],
        filters: [],
        ...overrides,
    };
}

describe('grid-url-state — `f` filter codec (positional-tuple JSON)', () => {
    it('round-trips typed filters (string / number / boolean / array values)', () => {
        const filters: FilterRule[] = [
            { id: 'name', operator: 'iLike', variant: 'text', value: 'acme' },
            { id: 'age', operator: 'gt', variant: 'number', value: 18 },
            { id: 'isActive', operator: 'eq', variant: 'boolean', value: true },
            { id: 'plan', operator: 'inArray', variant: 'multiSelect', value: ['pro', 'ent'] },
        ];

        const encoded = encodeFilters(filters);
        expect(encoded).toBe(JSON.stringify([
            ['name', 'iLike', 'text', 'acme'],
            ['age', 'gt', 'number', 18],
            ['isActive', 'eq', 'boolean', true],
            ['plan', 'inArray', 'multiSelect', ['pro', 'ent']],
        ]));
        expect(decodeFilters(encoded)).toEqual(filters);
    });

    it('decodes empty / invalid input to an empty array (best-effort, never throws)', () => {
        expect(decodeFilters('')).toEqual([]);
        expect(decodeFilters('{not json')).toEqual([]);
        expect(decodeFilters('{"a":1}')).toEqual([]);
    });

    it('drops tuples with an unknown operator or variant', () => {
        const raw = JSON.stringify([
            ['name', 'iLike', 'text', 'acme'],
            ['name', 'bogusOp', 'text', 'x'],
            ['name', 'eq', 'bogusVariant', 'x'],
            ['', 'eq', 'text', 'x'],
        ]);
        expect(decodeFilters(raw)).toEqual([{ id: 'name', operator: 'iLike', variant: 'text', value: 'acme' }]);
    });

    it('exposes the `f` key parser in the combined nuqs parser map', () => {
        expect(gridQueryParsers.f.parse(encodeFilters([{ id: 'name', operator: 'iLike', variant: 'text', value: 'acme' }]))).toEqual([
            { id: 'name', operator: 'iLike', variant: 'text', value: 'acme' },
        ]);
    });
});

describe('grid-url-state — parseSearchParams', () => {
    it('applies console defaults (page 0, limit 25) for an empty query', () => {
        expect(parseSearchParams(new URLSearchParams())).toEqual({
            pagination: { mode: 'offset', page: 0, limit: 25 },
            sorting: [],
            filters: [],
            globalSearch: undefined,
        });
    });

    it('parses search / page / limit / sort / f into a DataQueryState', () => {
        const params = new URLSearchParams();
        params.set('search', 'sunrise');
        params.set('page', '2');
        params.set('limit', '50');
        params.set('sort', 'name:asc,createdAt:desc');
        params.set('f', encodeFilters([{ id: 'status', operator: 'eq', variant: 'select', value: 'ENABLED' }]));

        expect(parseSearchParams(params)).toEqual({
            pagination: { mode: 'offset', page: 2, limit: 50 },
            sorting: [
                { id: 'name', desc: false },
                { id: 'createdAt', desc: true },
            ],
            filters: [{ id: 'status', operator: 'eq', variant: 'select', value: 'ENABLED' }],
            globalSearch: 'sunrise',
        });
    });

    it('accepts a plain search-params record as well as URLSearchParams', () => {
        expect(parseSearchParams({ page: '3', limit: '10' }).pagination).toEqual({ mode: 'offset', page: 3, limit: 10 });
    });
});

describe('grid-url-state — toListParams (pagination / search / sort)', () => {
    it('serializes offset pagination and trimmed global search', () => {
        expect(toListParams(offsetState({ pagination: { mode: 'offset', page: 1, limit: 50 }, globalSearch: '  sunrise  ' }))).toEqual({
            page: 1,
            limit: 50,
            search: 'sunrise',
        });
    });

    it('emits comma-separated sort pairs and joins searchFields from options', () => {
        const out = toListParams(offsetState({ sorting: [{ id: 'name', desc: false }, { id: 'createdAt', desc: true }] }), {
            searchFields: ['name', 'key'],
        });
        expect(out.sort).toBe('name:asc,createdAt:desc');
        expect(out.searchFields).toBe('name,key');
    });

    it('serializes cursor pagination to limit (+cursor), no page', () => {
        const out = toListParams({ pagination: { mode: 'cursor', cursor: 'abc', limit: 20 }, sorting: [], filters: [] });
        expect(out.limit).toBe(20);
        expect(out.page).toBeUndefined();
        expect(out.cursor).toBe('abc');
    });
});

describe('grid-url-state — toListParams filters bracket grammar', () => {
    function filtersOf(filters: FilterRule[]): string | undefined {
        return toListParams(offsetState({ filters })).filters;
    }

    it('maps text ops to case-insensitive tokens (icontains default, iequals for "is")', () => {
        expect(filtersOf([{ id: 'name', operator: 'iLike', variant: 'text', value: 'acme' }])).toBe('name[icontains]:acme');
        expect(filtersOf([{ id: 'name', operator: 'eq', variant: 'text', value: 'acme' }])).toBe('name[iequals]:acme');
    });

    it('maps equality on enum/boolean/number/date to case-sensitive [equals] (never an i-op)', () => {
        expect(filtersOf([{ id: 'status', operator: 'eq', variant: 'select', value: 'ENABLED' }])).toBe('status[equals]:ENABLED');
        expect(filtersOf([{ id: 'isActive', operator: 'eq', variant: 'boolean', value: true }])).toBe('isActive[equals]:true');
        expect(filtersOf([{ id: 'age', operator: 'eq', variant: 'number', value: 30 }])).toBe('age[equals]:30');
    });

    it('maps numeric comparison operators directly', () => {
        expect(filtersOf([{ id: 'age', operator: 'gt', variant: 'number', value: 18 }])).toBe('age[gt]:18');
        expect(filtersOf([{ id: 'age', operator: 'lte', variant: 'number', value: 65 }])).toBe('age[lte]:65');
    });

    it('maps multiSelect list ops to pipe-joined [in] / [notIn]', () => {
        expect(filtersOf([{ id: 'plan', operator: 'inArray', variant: 'multiSelect', value: ['pro', 'ent'] }])).toBe('plan[in]:pro|ent');
        expect(filtersOf([{ id: 'plan', operator: 'notInArray', variant: 'multiSelect', value: ['free'] }])).toBe('plan[notIn]:free');
    });

    it('expands isBetween into a gte;lte range on one field', () => {
        expect(filtersOf([{ id: 'score', operator: 'isBetween', variant: 'range', value: [10, 20] }])).toBe('score[gte]:10;score[lte]:20');
        expect(filtersOf([{ id: 'createdAt', operator: 'isBetween', variant: 'dateRange', value: ['2024-01-01', '2024-12-31'] }])).toBe(
            'createdAt[gte]:2024-01-01;createdAt[lte]:2024-12-31',
        );
    });

    it('joins multiple filter tokens with ";" (never ",")', () => {
        const out = filtersOf([
            { id: 'name', operator: 'iLike', variant: 'text', value: 'acme' },
            { id: 'status', operator: 'eq', variant: 'select', value: 'ENABLED' },
        ]);
        expect(out).toBe('name[icontains]:acme;status[equals]:ENABLED');
    });

    it('omits blank/empty tokens and never emits trailing pipes', () => {
        expect(filtersOf([{ id: 'name', operator: 'iLike', variant: 'text', value: '   ' }])).toBeUndefined();
        expect(filtersOf([{ id: 'plan', operator: 'inArray', variant: 'multiSelect', value: [] }])).toBeUndefined();
        expect(filtersOf([{ id: 'plan', operator: 'inArray', variant: 'multiSelect', value: ['pro', '', null] }])).toBe('plan[in]:pro');
    });

    it('does NOT emit a list token when any value contains a literal pipe', () => {
        expect(filtersOf([{ id: 'plan', operator: 'inArray', variant: 'multiSelect', value: ['a|b', 'c'] }])).toBeUndefined();
    });

    it('emits only the provided bound for a half-open range', () => {
        expect(filtersOf([{ id: 'score', operator: 'isBetween', variant: 'range', value: [10, ''] }])).toBe('score[gte]:10');
        expect(filtersOf([{ id: 'score', operator: 'isBetween', variant: 'range', value: ['', 20] }])).toBe('score[lte]:20');
    });

    it('drops operators unsupported by the v1 server grammar (ne / notILike / isEmpty / isNotEmpty / isRelativeToToday)', () => {
        expect(filtersOf([{ id: 'name', operator: 'ne', variant: 'text', value: 'x' }])).toBeUndefined();
        expect(filtersOf([{ id: 'name', operator: 'notILike', variant: 'text', value: 'x' }])).toBeUndefined();
        expect(filtersOf([{ id: 'name', operator: 'isEmpty', variant: 'text', value: '' }])).toBeUndefined();
        expect(filtersOf([{ id: 'name', operator: 'isNotEmpty', variant: 'text', value: '' }])).toBeUndefined();
        expect(filtersOf([{ id: 'createdAt', operator: 'isRelativeToToday', variant: 'date', value: '7d' }])).toBeUndefined();
    });

    it('never emits an i-op on a non-text column (guards the enum/number/date rule)', () => {
        expect(filtersOf([{ id: 'status', operator: 'iLike', variant: 'select', value: 'ENABLED' }])).toBeUndefined();
    });
});
