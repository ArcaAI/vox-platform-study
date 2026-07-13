import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';

import { useDataGrid } from '../use-data-grid';
import { useGridLayout } from '../use-grid-layout';
import { VirtualizedDataGrid } from '../virtualized-data-grid';
import type { GridLayoutState, GridLayoutPersistenceAdapter, VirtualizedDataGridProps } from '../types';
import type { DataQueryState } from '@/lib/shared';

expect.extend(axeMatchers);

beforeAll(() => {
  // @tanstack/react-virtual + dnd-kit need ResizeObserver in the test DOM.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // happy-dom has no layout engine, so getBoundingClientRect() reports 0×0 and the
  // virtualizer renders an empty window. Give every element a fixed viewport box so
  // the scroll container measures a real height and react-virtual yields rows.
  if (!Element.prototype.getBoundingClientRect || Element.prototype.getBoundingClientRect.toString().includes('[native code]')) {
    Element.prototype.getBoundingClientRect = function () {
      return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  }
  for (const [prop, value] of [['clientHeight', 600], ['clientWidth', 800], ['offsetHeight', 600], ['offsetWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

interface Person {
  id: string;
  name: string;
  status: string;
}

const COLUMNS: ColumnDef<Person>[] = [
  { accessorKey: 'name', meta: { label: 'Name', variant: 'text' } },
  { accessorKey: 'status', meta: { label: 'Status', variant: 'multiSelect', options: [
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Archived', value: 'ARCHIVED' },
  ] } },
];

function makeData(n: number): Person[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, status: i % 2 ? 'ACTIVE' : 'ARCHIVED' }));
}

function renderGrid(props: Partial<VirtualizedDataGridProps<Person>> = {}) {
  const base: VirtualizedDataGridProps<Person> = {
    data: makeData(5),
    columns: COLUMNS,
    getRowId: (row) => row.id,
    ...props,
  };
  return render(<VirtualizedDataGrid<Person> {...base} />);
}

describe('useDataGrid (headless controller)', () => {
  it('emits a SortRule when a column toggles sorting (asc → desc → none)', () => {
    const onQueryStateChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onQueryStateChange }));

    act(() => result.current.table.getColumn('name')!.toggleSorting(false));
    expect(onQueryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sorting: [{ id: 'name', desc: false }] }));

    act(() => result.current.table.getColumn('name')!.toggleSorting(true));
    expect(onQueryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sorting: [{ id: 'name', desc: true }] }));

    act(() => result.current.table.getColumn('name')!.clearSorting());
    expect(onQueryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ sorting: [] }));
  });

  it('produces a FilterRule via setFilter (faceted filter mechanism)', () => {
    const onQueryStateChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onQueryStateChange }));

    act(() => result.current.setFilter({ id: 'status', operator: 'inArray', value: ['ACTIVE'], variant: 'multiSelect' }, 'status'));
    expect(onQueryStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ id: 'status', operator: 'inArray', value: ['ACTIVE'], variant: 'multiSelect' }] }),
    );
  });

  it('filters to the union of selected values for a multiSelect column with no explicit filterFn (TASK-500)', () => {
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(4), columns: COLUMNS, getRowId: (r) => r.id }));

    act(() => result.current.setFilter({ id: 'status', operator: 'inArray', value: ['ACTIVE'], variant: 'multiSelect' }, 'status'));
    expect(result.current.table.getFilteredRowModel().rows.map((r) => r.original.id).sort()).toEqual(['p1', 'p3']);

    act(() => result.current.setFilter({ id: 'status', operator: 'inArray', value: ['ACTIVE', 'ARCHIVED'], variant: 'multiSelect' }, 'status'));
    expect(result.current.table.getFilteredRowModel().rows.map((r) => r.original.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('emits onPaginate with an offset PageRequest on page change and respects rowCount', () => {
    const onPaginate = vi.fn();
    const { result } = renderHook(() =>
      useDataGrid<Person>({
        data: makeData(20),
        columns: COLUMNS,
        getRowId: (r) => r.id,
        manual: { pagination: true },
        rowCount: 200,
        defaultQueryState: { pagination: { mode: 'offset', page: 0, limit: 20 } },
        onPaginate,
      }),
    );
    expect(result.current.table.getPageCount()).toBe(10); // 200 / 20
    act(() => result.current.table.setPageIndex(2));
    expect(onPaginate).toHaveBeenLastCalledWith({ mode: 'offset', page: 2, limit: 20 });
  });

  it('debounces global search', () => {
    vi.useFakeTimers();
    const onQueryStateChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onQueryStateChange }));
    act(() => {
      result.current.setGlobalSearch('a');
      result.current.setGlobalSearch('ab');
      result.current.setGlobalSearch('abc');
    });
    expect(onQueryStateChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(onQueryStateChange).toHaveBeenCalledTimes(1);
    expect(onQueryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ globalSearch: 'abc' }));
    vi.useRealTimers();
  });

  it('cannot hide the last visible content column', () => {
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id }));
    act(() => result.current.table.getColumn('name')!.toggleVisibility(false));
    expect(result.current.table.getColumn('name')!.getIsVisible()).toBe(false);
    // Hiding the only remaining content column must be a no-op.
    act(() => result.current.table.getColumn('status')!.toggleVisibility(false));
    expect(result.current.table.getColumn('status')!.getIsVisible()).toBe(true);
  });

  it('keeps row selection (by id) across a page change', () => {
    const { result } = renderHook(() =>
      useDataGrid<Person>({ data: makeData(40), columns: COLUMNS, getRowId: (r) => r.id, defaultQueryState: { pagination: { mode: 'offset', page: 0, limit: 10 } } }),
    );
    act(() => result.current.table.getRow('p0').toggleSelected(true));
    expect(result.current.table.getState().rowSelection).toEqual({ p0: true });
    act(() => result.current.table.setPageIndex(2));
    expect(result.current.table.getState().rowSelection).toEqual({ p0: true });
  });

  it('updates density and emits onColumnChange', () => {
    const onColumnChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onColumnChange }));
    expect(result.current.density).toBe('comfortable');
    act(() => result.current.setDensity('compact'));
    expect(result.current.density).toBe('compact');
    expect(onColumnChange).toHaveBeenLastCalledWith(expect.objectContaining({ density: 'compact' }));
  });

  it('reorders columns via moveColumn and emits onColumnChange', () => {
    const onColumnChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onColumnChange }));
    act(() => result.current.moveColumn('name', 'status'));
    expect(onColumnChange).toHaveBeenLastCalledWith(expect.objectContaining({ order: expect.arrayContaining(['name', 'status']) }));
    const order = result.current.table.getState().columnOrder;
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('name'));
  });

  it('supports controlled queryState (does not self-update internal state)', () => {
    const onQueryStateChange = vi.fn();
    const controlled: DataQueryState = { pagination: { mode: 'offset', page: 0, limit: 20 }, sorting: [], filters: [] };
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, queryState: controlled, onQueryStateChange }));
    act(() => result.current.table.getColumn('name')!.toggleSorting(false));
    expect(onQueryStateChange).toHaveBeenCalled();
    // Controlled: internal value stays equal to the prop until the parent updates it.
    expect(result.current.queryState.sorting).toEqual([]);
  });
});

describe('VirtualizedDataGrid (shell)', () => {
  it('renders rows from data', () => {
    renderGrid({ data: makeData(3) });
    expect(screen.getByText('Person 0')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('renders an empty state when data is empty and not loading', () => {
    renderGrid({ data: [] });
    // The pager status also reads "No results" for 0 rows (§F); scope to the grid body.
    expect(within(screen.getByRole('grid')).getByText('No results')).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    renderGrid({ data: [], isLoading: true });
    expect(screen.getByLabelText('Loading data')).toBeInTheDocument();
  });

  it('shows an error state with a retry button', () => {
    const onRetry = vi.fn();
    renderGrid({ data: [], error: new Error('boom'), onRetry });
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('exposes role=grid with aria-rowcount equal to the true total (+ header)', () => {
    renderGrid({ data: makeData(20), manual: { pagination: true }, rowCount: 5000 });
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '5001');
  });

  it('virtualizes large datasets to a bounded number of DOM rows', () => {
    renderGrid({ data: makeData(1000), defaultQueryState: { pagination: { mode: 'offset', page: 0, limit: 1000 } } });
    const dataRows = screen.queryAllByRole('row').filter((r) => r.getAttribute('aria-rowindex') !== '1');
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThan(200);
  });

  it('hides numbered pages in cursor mode and disables next when there is no more', () => {
    renderGrid({ data: makeData(10), pageMode: 'cursor', cursor: { hasMore: false, nextCursor: null } });
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('selects the filtered set on Ctrl/Cmd+A', () => {
    const onChange = vi.fn();
    renderGrid({ data: makeData(5), selection: { value: {}, onChange } });
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'a', ctrlKey: true });
    expect(onChange).toHaveBeenCalled();
    const lastSelection = onChange.mock.calls.at(-1)![0] as RowSelectionState;
    expect(Object.keys(lastSelection).length).toBe(5);
  });

  it('shows the actionBar only when there is a selection', () => {
    const { rerender } = render(
      <VirtualizedDataGrid<Person> data={makeData(3)} columns={COLUMNS} getRowId={(r) => r.id} actionBar={<div>Bulk actions</div>} selection={{ value: {} }} />,
    );
    expect(screen.queryByText('Bulk actions')).not.toBeInTheDocument();
    rerender(
      <VirtualizedDataGrid<Person> data={makeData(3)} columns={COLUMNS} getRowId={(r) => r.id} actionBar={<div>Bulk actions</div>} selection={{ value: { p0: true } }} />,
    );
    expect(screen.getByText('Bulk actions')).toBeInTheDocument();
  });

  it('calls onRowClick with the row original', () => {
    const onRowClick = vi.fn();
    renderGrid({ data: makeData(3), onRowClick });
    fireEvent.click(screen.getByText('Person 1'));
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('has no axe violations', async () => {
    const { container } = renderGrid({ data: makeData(3) });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });

  it('height-constrains body cells to the fixed virtual row so oversized content clips instead of covering row borders (TASK-429)', () => {
    renderGrid({ data: makeData(3) });
    const cells = screen.getAllByRole('gridcell');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      // Rows have a hard virtualized height; without h-full a wrapping cell grows
      // past the row box and its opaque bg-card paints over the row border-b.
      expect(cell.className).toContain('h-full');
      expect(cell.className).toContain('truncate');
    }
  });

  it('adds aria-colindex to header and body cells (Δ9)', () => {
    renderGrid({ data: makeData(3) });
    const headers = screen.getAllByRole('columnheader');
    // Augmented order: [select, name, status] → 1-based colindex.
    expect(headers[0]).toHaveAttribute('aria-colindex', '1');
    expect(headers[1]).toHaveAttribute('aria-colindex', '2');
    expect(headers[2]).toHaveAttribute('aria-colindex', '3');
    const firstCell = screen.getAllByRole('gridcell')[0];
    expect(firstCell).toHaveAttribute('aria-colindex', '1');
  });

  it('exposes a polite live-region status node (Δ9)', () => {
    const { container } = renderGrid({ data: makeData(3) });
    const status = container.querySelector('[role="status"][aria-live="polite"].sr-only');
    expect(status).not.toBeNull();
  });

  it('renders a keyboard-resizable separator and grows the column on ArrowRight (Δ3, WCAG 2.5.7)', () => {
    renderGrid({ data: makeData(3) });
    const sep = screen.getByRole('separator', { name: /resize name column/i });
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    const after = Number(screen.getByRole('separator', { name: /resize name column/i }).getAttribute('aria-valuenow'));
    expect(after).toBe(before + 16);
  });

  it('shows an item-range status in the pagination region (Δ7)', () => {
    renderGrid({ data: makeData(3) });
    const nav = screen.getByRole('navigation', { name: /pagination/i });
    // md container copy drops the "Showing" prefix but always keeps "…of {total}".
    expect(nav.textContent).toMatch(/1[\u2013-]3 of 3/);
  });

  it('renders the toolbar "Clear filters" affordance when a filter/search is active (Δ6)', () => {
    renderGrid({ data: makeData(3), defaultQueryState: { globalSearch: 'acme' } });
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  it('gates the first body paint on isLayoutReady — skeleton until persistence resolves (Δ8)', async () => {
    let resolveLoad: (v: GridLayoutState | null) => void = () => {};
    const loaded = new Promise<GridLayoutState | null>((res) => (resolveLoad = res));
    const adapter: GridLayoutPersistenceAdapter = {
      load: vi.fn().mockReturnValue(loaded),
      save: vi.fn().mockResolvedValue(undefined),
    };
    renderGrid({ data: makeData(3), persistence: { key: 'tenants', adapter } });
    expect(screen.getByLabelText('Loading data')).toBeInTheDocument();
    expect(screen.queryByText('Person 0')).not.toBeInTheDocument();
    await act(async () => {
      resolveLoad(null);
      await loaded.catch(() => {});
    });
    expect(await screen.findByText('Person 0')).toBeInTheDocument();
  });
});

describe('useDataGrid — personalization, a11y announcements & page sizes (Δ4/Δ7/Δ8/Δ9)', () => {
  it('defaults to page-size options [25, 50, 100] with limit 25', () => {
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id }));
    expect(result.current.pageSizeOptions).toEqual([25, 50, 100]);
    expect(result.current.queryState.pagination).toMatchObject({ mode: 'offset', limit: 25 });
  });

  it('moveColumnDirection swaps with the left neighbour (Δ4 keyboard reorder)', () => {
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id }));
    act(() => result.current.moveColumnDirection('status', 'left'));
    const order = result.current.table.getState().columnOrder;
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('name'));
  });

  it('announces sort changes in the live region (Δ9)', () => {
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id }));
    act(() => result.current.table.getColumn('name')!.toggleSorting(false));
    expect(result.current.announcement).toContain('Sorted by Name, ascending');
  });

  it('resetLayout restores defaults and announces the reset (Δ8)', () => {
    const onColumnChange = vi.fn();
    const { result } = renderHook(() => useDataGrid<Person>({ data: makeData(3), columns: COLUMNS, getRowId: (r) => r.id, onColumnChange }));
    act(() => result.current.setDensity('compact'));
    expect(result.current.density).toBe('compact');
    act(() => result.current.resetLayout());
    expect(result.current.density).toBe('comfortable');
    expect(result.current.announcement).toMatch(/reset/i);
    expect(onColumnChange).toHaveBeenLastCalledWith(expect.objectContaining({ density: 'comfortable', order: [], sizing: {}, visibility: {}, pinning: {} }));
  });
});

describe('useGridLayout (D8 persistence)', () => {
  function makeAdapter(loaded: GridLayoutState | null = null): GridLayoutPersistenceAdapter & { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
    return {
      load: vi.fn().mockResolvedValue(loaded),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }
  const defaultLayout: GridLayoutState = { order: [], sizing: {}, visibility: {}, pinning: {}, density: 'comfortable' };

  it('loads layout on mount and applies it (isLayoutReady flips true)', async () => {
    const saved: GridLayoutState = { order: ['status', 'name'], sizing: {}, visibility: { name: false }, pinning: {}, density: 'compact' };
    const adapter = makeAdapter(saved);
    const { result } = renderHook(() => useGridLayout({ persistence: { key: 'tenants', adapter }, defaultLayout }));
    expect(result.current.isLayoutReady).toBe(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapter.load).toHaveBeenCalledWith('ui.data-grid', 'tenants');
    expect(result.current.isLayoutReady).toBe(true);
    expect(result.current.layout.density).toBe('compact');
    expect(result.current.layout.order).toEqual(['status', 'name']);
  });

  it('debounce-coalesces rapid changes into a single save', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const { result } = renderHook(() => useGridLayout({ persistence: { key: 'tenants', adapter, debounceMs: 500 }, defaultLayout }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.setLayout({ ...defaultLayout, density: 'compact' });
      result.current.setLayout({ ...defaultLayout, density: 'comfortable' });
      result.current.setLayout({ ...defaultLayout, order: ['status', 'name'] });
    });
    expect(adapter.save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(adapter.save).toHaveBeenLastCalledWith('ui.data-grid', 'tenants', expect.objectContaining({ order: ['status', 'name'] }));
    vi.useRealTimers();
  });

  it('falls back to defaults without throwing when the adapter rejects', async () => {
    const adapter: GridLayoutPersistenceAdapter = {
      load: vi.fn().mockRejectedValue(new Error('settings unavailable')),
      save: vi.fn(),
    };
    const { result } = renderHook(() => useGridLayout({ persistence: { key: 'tenants', adapter }, defaultLayout }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isLayoutReady).toBe(true);
    expect(result.current.layout).toEqual(defaultLayout);
  });

  it('is ready immediately and never saves when persistence is disabled', () => {
    const adapter = makeAdapter();
    const { result } = renderHook(() => useGridLayout({ persistence: { key: 'tenants', adapter, enabled: false }, defaultLayout }));
    expect(result.current.isLayoutReady).toBe(true);
    act(() => result.current.setLayout({ ...defaultLayout, density: 'compact' }));
    expect(adapter.save).not.toHaveBeenCalled();
  });
});
