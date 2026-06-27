import { describe, it, expect } from 'vitest';
import { DEFAULT_QUERY_STATE, toPaginatedQuery, type DataQueryState } from '../query-state';

function makeState(overrides: Partial<DataQueryState> = {}): DataQueryState {
  return {
    pagination: { mode: 'offset', page: 0, limit: 20 },
    sorting: [],
    filters: [],
    ...overrides,
  };
}

describe('lib/shared/query-state', () => {
  it('exposes a default offset query state', () => {
    expect(DEFAULT_QUERY_STATE.pagination).toEqual({ mode: 'offset', page: 0, limit: 20 });
    expect(DEFAULT_QUERY_STATE.sorting).toEqual([]);
    expect(DEFAULT_QUERY_STATE.filters).toEqual([]);
  });

  it('serializes offset pagination to page/limit', () => {
    const q = toPaginatedQuery(makeState({ pagination: { mode: 'offset', page: 2, limit: 50 } }));
    expect(q.page).toBe('2');
    expect(q.limit).toBe('50');
    expect(q.cursor).toBeUndefined();
  });

  it('serializes cursor pagination to cursor/limit and omits page', () => {
    const q = toPaginatedQuery(makeState({ pagination: { mode: 'cursor', cursor: 'abc', limit: 25 } }));
    expect(q.cursor).toBe('abc');
    expect(q.limit).toBe('25');
    expect(q.page).toBeUndefined();
  });

  it('serializes sorting to CSV field:asc|desc', () => {
    const q = toPaginatedQuery(
      makeState({ sorting: [{ id: 'name', desc: false }, { id: 'createdAt', desc: true }] }),
    );
    expect(q.sort).toBe('name:asc,createdAt:desc');
  });

  it('serializes filters to CSV field:value and drops empty values', () => {
    const q = toPaginatedQuery(
      makeState({
        filters: [
          { id: 'name', operator: 'iLike', value: 'John', variant: 'text' },
          { id: 'status', operator: 'inArray', value: ['ACTIVE', 'ARCHIVED'], variant: 'multiSelect' },
          { id: 'empty', operator: 'eq', value: '', variant: 'text' },
          { id: 'none', operator: 'inArray', value: [], variant: 'multiSelect' },
        ],
      }),
    );
    expect(q.filters).toBe('name:John,status:ACTIVE|ARCHIVED');
  });

  it('serializes globalSearch to search', () => {
    const q = toPaginatedQuery(makeState({ globalSearch: 'hello' }));
    expect(q.search).toBe('hello');
  });

  it('omits absent optional keys', () => {
    const q = toPaginatedQuery(makeState());
    expect(q.sort).toBeUndefined();
    expect(q.filters).toBeUndefined();
    expect(q.search).toBeUndefined();
  });
});
