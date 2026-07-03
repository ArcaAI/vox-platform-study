import { describe, expect, it } from 'vitest';
import { bulkSelectionReducer, selectedRowIds, selectionCount } from '../bulk-selection';

describe('selectedRowIds / selectionCount (bulk action bar reads the grid RowSelectionState)', () => {
  it('returns only the truthy-selected row ids', () => {
    expect(selectedRowIds({ a: true, b: false, c: true })).toEqual(['a', 'c']);
    expect(selectionCount({ a: true, b: false, c: true })).toBe(2);
  });

  it('treats an empty selection as zero', () => {
    expect(selectedRowIds({})).toEqual([]);
    expect(selectionCount({})).toBe(0);
  });
});

describe('bulkSelectionReducer (controlled grid selection + Clear)', () => {
  it('set normalizes the next selection, dropping id:false entries the table emits', () => {
    expect(bulkSelectionReducer({ a: true }, { type: 'set', value: { a: true, b: false, c: true } })).toEqual({ a: true, c: true });
  });

  it('clear empties the selection', () => {
    expect(bulkSelectionReducer({ a: true, b: true }, { type: 'clear' })).toEqual({});
  });
});
