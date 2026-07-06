import { describe, it, expect } from 'vitest';

import { toPaginatedQuery, filterRuleToTokens, FILTER_OPERATOR_TOKENS } from '@/lib/shared/query-state';
import type { DataQueryState, FilterRule } from '@/lib/shared';

function baseState(filters: FilterRule[], extra: Partial<DataQueryState> = {}): DataQueryState {
  return { pagination: { mode: 'offset', page: 0, limit: 25 }, sorting: [], filters, ...extra };
}

describe('toPaginatedQuery — pagination / search / sort (unchanged contract)', () => {
  it('serializes offset pagination + search', () => {
    const out = toPaginatedQuery(baseState([], { globalSearch: 'acme' }));
    expect(out.page).toBe('0');
    expect(out.limit).toBe('25');
    expect(out.search).toBe('acme');
  });

  it('serializes cursor pagination', () => {
    const out = toPaginatedQuery({ pagination: { mode: 'cursor', cursor: 'abc', limit: 50 }, sorting: [], filters: [] });
    expect(out.cursor).toBe('abc');
    expect(out.limit).toBe('50');
    expect(out.page).toBeUndefined();
  });

  it('serializes sort as a comma-joined field:dir list (NOT bracket grammar)', () => {
    const out = toPaginatedQuery(baseState([], { sorting: [{ id: 'name', desc: false }, { id: 'createdAt', desc: true }] }));
    expect(out.sort).toBe('name:asc,createdAt:desc');
  });
});

describe('filterRuleToTokens — bracket grammar per operator/variant', () => {
  it('text default (iLike) → [icontains] (case-insensitive)', () => {
    expect(filterRuleToTokens({ id: 'name', operator: 'iLike', value: 'ac', variant: 'text' })).toEqual(['name[icontains]:ac']);
  });

  it('text eq → [iequals] (case-insensitive equals)', () => {
    expect(filterRuleToTokens({ id: 'name', operator: 'eq', value: 'Acme', variant: 'text' })).toEqual(['name[iequals]:Acme']);
  });

  it('does NOT emit i-ops on enum/number/boolean/date — uses [equals]', () => {
    expect(filterRuleToTokens({ id: 'plan', operator: 'eq', value: 'PRO', variant: 'select' })).toEqual(['plan[equals]:PRO']);
    expect(filterRuleToTokens({ id: 'active', operator: 'eq', value: 'true', variant: 'boolean' })).toEqual(['active[equals]:true']);
    expect(filterRuleToTokens({ id: 'count', operator: 'eq', value: '5', variant: 'number' })).toEqual(['count[equals]:5']);
  });

  it('number comparisons → [gt|gte|lt|lte]', () => {
    expect(filterRuleToTokens({ id: 'count', operator: 'gt', value: '5', variant: 'number' })).toEqual(['count[gt]:5']);
    expect(filterRuleToTokens({ id: 'count', operator: 'gte', value: '5', variant: 'number' })).toEqual(['count[gte]:5']);
    expect(filterRuleToTokens({ id: 'count', operator: 'lt', value: '5', variant: 'number' })).toEqual(['count[lt]:5']);
    expect(filterRuleToTokens({ id: 'count', operator: 'lte', value: '5', variant: 'number' })).toEqual(['count[lte]:5']);
  });

  it('range (isBetween) → two tokens field[gte]:X;field[lte]:Y', () => {
    expect(filterRuleToTokens({ id: 'count', operator: 'isBetween', value: ['1', '9'], variant: 'range' })).toEqual(['count[gte]:1', 'count[lte]:9']);
  });

  it('date isBetween → gte/lte with ISO values', () => {
    expect(
      filterRuleToTokens({ id: 'createdAt', operator: 'isBetween', value: ['2026-01-01', '2026-01-31'], variant: 'dateRange' }),
    ).toEqual(['createdAt[gte]:2026-01-01', 'createdAt[lte]:2026-01-31']);
  });

  it('isRelativeToToday resolves to a gte/lte pair (value already resolved to [start,end])', () => {
    expect(
      filterRuleToTokens({ id: 'createdAt', operator: 'isRelativeToToday', value: ['2026-06-29', '2026-07-06'], variant: 'date' }),
    ).toEqual(['createdAt[gte]:2026-06-29', 'createdAt[lte]:2026-07-06']);
  });

  it('range with only one bound emits a single token (omit the blank bound)', () => {
    expect(filterRuleToTokens({ id: 'count', operator: 'isBetween', value: ['1', ''], variant: 'range' })).toEqual(['count[gte]:1']);
    expect(filterRuleToTokens({ id: 'count', operator: 'isBetween', value: ['', '9'], variant: 'range' })).toEqual(['count[lte]:9']);
  });

  it('multiSelect inArray → [in] pipe-separated; notInArray → [notIn]', () => {
    expect(filterRuleToTokens({ id: 'status', operator: 'inArray', value: ['A', 'B', 'C'], variant: 'multiSelect' })).toEqual(['status[in]:A|B|C']);
    expect(filterRuleToTokens({ id: 'status', operator: 'notInArray', value: ['A', 'B'], variant: 'multiSelect' })).toEqual(['status[notIn]:A|B']);
  });

  it('omits list tokens for empty selections (never emits field[in]: or a trailing |)', () => {
    expect(filterRuleToTokens({ id: 'status', operator: 'inArray', value: [], variant: 'multiSelect' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'status', operator: 'inArray', value: ['', ''], variant: 'multiSelect' })).toEqual([]);
  });

  it('drops list items containing a literal | (unrepresentable in the pipe grammar)', () => {
    expect(filterRuleToTokens({ id: 'status', operator: 'inArray', value: ['A', 'B|C', 'D'], variant: 'multiSelect' })).toEqual(['status[in]:A|D']);
    // all items unrepresentable → omit the token entirely
    expect(filterRuleToTokens({ id: 'status', operator: 'inArray', value: ['B|C'], variant: 'multiSelect' })).toEqual([]);
  });

  it('omits scalar tokens with empty/blank values', () => {
    expect(filterRuleToTokens({ id: 'name', operator: 'iLike', value: '', variant: 'text' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'name', operator: 'iLike', value: '   ', variant: 'text' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'name', operator: 'iLike', value: null, variant: 'text' })).toEqual([]);
  });

  it('omits operators that cannot be expressed server-side in v1 (ne, notILike, isEmpty, isNotEmpty)', () => {
    expect(filterRuleToTokens({ id: 'name', operator: 'ne', value: 'x', variant: 'text' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'name', operator: 'notILike', value: 'x', variant: 'text' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'name', operator: 'isEmpty', value: '', variant: 'text' })).toEqual([]);
    expect(filterRuleToTokens({ id: 'name', operator: 'isNotEmpty', value: '', variant: 'text' })).toEqual([]);
  });

  it('exposes a static operator→token map for the documented (variant-independent) scalar ops', () => {
    expect(FILTER_OPERATOR_TOKENS.gte).toBe('gte');
    expect(FILTER_OPERATOR_TOKENS.eq).toBe('equals');
  });
});

describe('toPaginatedQuery — filters use the bracket grammar joined by ";"', () => {
  it('joins multiple filter tokens with ; (comma is reserved for AND/OR internals)', () => {
    const out = toPaginatedQuery(
      baseState([
        { id: 'name', operator: 'iLike', value: 'ac', variant: 'text' },
        { id: 'status', operator: 'inArray', value: ['ACTIVE', 'ARCHIVED'], variant: 'multiSelect' },
        { id: 'count', operator: 'isBetween', value: ['1', '9'], variant: 'range' },
      ]),
    );
    expect(out.filters).toBe('name[icontains]:ac;status[in]:ACTIVE|ARCHIVED;count[gte]:1;count[lte]:9');
  });

  it('omits the filters param entirely when nothing is active', () => {
    const out = toPaginatedQuery(baseState([{ id: 'name', operator: 'iLike', value: '', variant: 'text' }]));
    expect(out.filters).toBeUndefined();
  });
});
