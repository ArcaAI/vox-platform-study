/**
 * Grid capabilities backing the settings list redesign:
 *   1. `groupBy` — injected, non-interactive group-header rows (label + count)
 *      between contiguous groups of the CURRENT page, virtualization intact,
 *      zero behaviour change when omitted.
 *   2. `meta.filterOnly` — a filter-only virtual column: it feeds a toolbar
 *      faceted-filter chip but never renders as a table column and is not
 *      offered in the column-visibility list.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import type { ColumnDef } from '@tanstack/react-table';

import { buildDisplayRows } from '../group-rows';
import { VirtualizedDataGrid } from '../virtualized-data-grid';
import type { VirtualizedDataGridProps } from '../types';

expect.extend(axeMatchers);

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Wide enough (≥1024) that the toolbar renders its faceted-filter chips
  // INLINE instead of collapsing them into the Filters popover.
  Element.prototype.getBoundingClientRect = function () {
    return { width: 1200, height: 600, top: 0, left: 0, right: 1200, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  for (const [prop, value] of [
    ['clientHeight', 600],
    ['clientWidth', 1200],
    ['offsetHeight', 600],
    ['offsetWidth', 1200],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

interface Setting {
  id: string;
  key: string;
  namespace: string | null;
  secret: boolean;
}

const COLUMNS: ColumnDef<Setting>[] = [
  { accessorKey: 'key', meta: { label: 'Key', variant: 'text' } },
  { accessorKey: 'namespace', meta: { label: 'Namespace' } },
];

const ROWS: Setting[] = [
  { id: 's1', key: 'smtp.host', namespace: 'smtp', secret: false },
  { id: 's2', key: 'smtp.port', namespace: 'smtp', secret: false },
  { id: 's3', key: 'llm.model', namespace: 'llm', secret: false },
  { id: 's4', key: 'orphan.key', namespace: null, secret: true },
];

function renderGrid(props: Partial<VirtualizedDataGridProps<Setting>> = {}) {
  const base: VirtualizedDataGridProps<Setting> = {
    data: ROWS,
    columns: COLUMNS,
    getRowId: (row) => row.id,
    features: { rowSelection: false },
    ...props,
  };
  return render(<VirtualizedDataGrid<Setting> {...base} />);
}

const GROUP_BY = { accessor: (row: Setting) => row.namespace };

describe('buildDisplayRows (pure grouping)', () => {
  // Minimal Row<T> stand-ins — buildDisplayRows only reads `original`.
  const asRows = (data: Setting[]) => data.map((original) => ({ original }) as never);

  it('passes rows through untouched when no groupBy is given', () => {
    const out = buildDisplayRows<Setting>(asRows(ROWS));
    expect(out).toHaveLength(4);
    expect(out.every((entry) => entry.kind === 'data')).toBe(true);
  });

  it('injects a header with a count ahead of each contiguous group', () => {
    const out = buildDisplayRows<Setting>(asRows(ROWS), GROUP_BY);
    expect(
      out.map((entry) => (entry.kind === 'group' ? `#${entry.label}:${entry.count}` : (entry as { row: { original: Setting } }).row.original.id)),
    ).toEqual(['#smtp:2', 's1', 's2', '#llm:1', 's3', '#—:1', 's4']);
  });

  it('re-opens a group when the same key reappears non-contiguously (page order is authoritative)', () => {
    const out = buildDisplayRows<Setting>(asRows([ROWS[0], ROWS[2], ROWS[1]]), GROUP_BY);
    expect(out.filter((entry) => entry.kind === 'group').map((entry) => (entry as { label: string }).label)).toEqual(['smtp', 'llm', 'smtp']);
  });

  it('honours a custom fallbackLabel for rows without a group value', () => {
    const out = buildDisplayRows<Setting>(asRows([ROWS[3]]), { ...GROUP_BY, fallbackLabel: 'No namespace' });
    expect(out[0]).toMatchObject({ kind: 'group', label: 'No namespace', count: 1 });
  });
});

describe('VirtualizedDataGrid groupBy', () => {
  it('renders group-header rows with label + count between contiguous groups', () => {
    renderGrid({ groupBy: GROUP_BY });

    const groupRows = document.querySelectorAll('[data-slot="data-grid-group-row"]');
    expect(groupRows).toHaveLength(3);
    expect(groupRows[0].textContent).toContain('smtp');
    expect(groupRows[0].textContent).toContain('2');
    expect(groupRows[1].textContent).toContain('llm');
    // Group headers are rows containing a full-width rowheader cell.
    expect(groupRows[0].getAttribute('role')).toBe('row');
    const rowheader = within(groupRows[0] as HTMLElement).getByRole('rowheader');
    expect(rowheader.getAttribute('aria-colspan')).toBe(String(COLUMNS.length));
  });

  it('keeps all data rows renderable alongside the headers (virtualization intact)', () => {
    renderGrid({ groupBy: GROUP_BY });
    for (const key of ['smtp.host', 'smtp.port', 'llm.model', 'orphan.key']) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
  });

  it('group headers are not clickable — onRowClick only fires for data rows', () => {
    const onRowClick = vi.fn();
    renderGrid({ groupBy: GROUP_BY, onRowClick });

    fireEvent.click(document.querySelectorAll('[data-slot="data-grid-group-row"]')[0]!);
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('llm.model'));
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: 's3' }));
  });

  it('supports a custom renderHeader', () => {
    renderGrid({ groupBy: { ...GROUP_BY, renderHeader: (label, count) => <em>{`${label} has ${count}`}</em> } });
    expect(screen.getByText('smtp has 2')).toBeInTheDocument();
  });

  it('renders no group rows when groupBy is omitted (behaviour unchanged)', () => {
    renderGrid();
    expect(document.querySelectorAll('[data-slot="data-grid-group-row"]')).toHaveLength(0);
    expect(screen.getByText('smtp.host')).toBeInTheDocument();
  });

  it('has no axe violations with grouping on', async () => {
    const { container } = renderGrid({ groupBy: GROUP_BY });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('meta.filterOnly (filter-only virtual column)', () => {
  const FILTER_ONLY_COLUMNS: ColumnDef<Setting>[] = [
    ...COLUMNS,
    {
      accessorKey: 'secret',
      enableSorting: false,
      meta: {
        label: 'Secrets',
        variant: 'boolean',
        filterOnly: true,
        options: [
          { label: 'Secret', value: 'true' },
          { label: 'Non-secret', value: 'false' },
        ],
      },
    },
  ];

  it('never renders the column but still offers its toolbar filter chip', () => {
    renderGrid({ columns: FILTER_ONLY_COLUMNS });

    expect(screen.queryByRole('columnheader', { name: /secrets/i })).toBeNull();
    // The faceted-filter chip is present and drives the query state.
    expect(screen.getByRole('button', { name: /secrets/i })).toBeInTheDocument();
  });

  it('emits the boolean FilterRule through the chip', () => {
    const onQueryStateChange = vi.fn();
    renderGrid({ columns: FILTER_ONLY_COLUMNS, onQueryStateChange });

    fireEvent.click(screen.getByRole('button', { name: /secrets/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Secret' }));

    expect(onQueryStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [expect.objectContaining({ id: 'secret', operator: 'eq', value: 'true', variant: 'boolean' })] }),
    );
  });

  it('is not offered in the column-visibility list', () => {
    renderGrid({ columns: FILTER_ONLY_COLUMNS });

    fireEvent.click(screen.getByRole('combobox', { name: /toggle columns/i }));
    const list = screen.getByRole('listbox', { name: /suggestions/i });
    expect(within(list).queryByText('Secrets')).toBeNull();
    expect(within(list).getByText('Key')).toBeInTheDocument();
  });
});
