'use client';

import * as React from 'react';
import { flexRender, type Header, type Row, type RowData } from '@tanstack/react-table';
import { type ColumnDef, type DataGridFeatures } from './table-features';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Inbox, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { Checkbox } from '@/components/shadcn/checkbox';
import { getColumnPinningStyle } from '@/lib/data-table';
import { DENSITY_ROW_HEIGHT } from '@/lib/shared/surface';
import { cn } from '@/lib/utils';

import { applyResizeKeydown } from './column-resize';
import { DataGridPagination } from './data-grid-pagination';
import { DataGridSkeleton } from './data-grid-skeleton';
import { DataGridColumnHeader } from './data-grid-column-header';
import { DataGridToolbar } from './data-grid-toolbar';
import { useDataGrid, type UseDataGridResult } from './use-data-grid';
import type { GroupByConfig, VirtualizedDataGridProps } from './types';

const SELECT_COLUMN_ID = 'select';

function makeSelectionColumn<TData extends RowData>(): ColumnDef<TData> {
  return {
    id: SELECT_COLUMN_ID,
    size: 40,
    minSize: 40,
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
    enableColumnFilter: false,
    header: ({ table }) => {
      const all = table.getIsAllPageRowsSelected();
      const some = table.getIsSomePageRowsSelected();
      return (
        <Checkbox
          aria-label="Select all rows"
          checked={all || (some && !all && 'indeterminate')}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
        />
      );
    },
    cell: ({ row }) => (
      <Checkbox
        aria-label="Select row"
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        onClick={(e) => e.stopPropagation()}
      />
    ),
  };
}

function HeaderCell<TData extends RowData>({
  header,
  grid,
  colIndex,
  enableReorder,
  enableResize,
  enablePinning,
  pinBorder,
}: {
  header: Header<DataGridFeatures, TData, unknown>;
  grid: UseDataGridResult<TData>;
  colIndex: number;
  enableReorder: boolean;
  enableResize: boolean;
  enablePinning: boolean;
  pinBorder: boolean;
}) {
  const table = grid.table;
  const column = header.column;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !enableReorder,
  });

  const sorted = column.getIsSorted();
  const ariaSort = sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none';

  const pinStyle = getColumnPinningStyle({ column, withBorder: pinBorder });
  const style: React.CSSProperties = {
    ...pinStyle,
    width: header.getSize(),
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    zIndex: isDragging ? 2 : pinStyle.zIndex,
  };

  const isSelect = column.id === SELECT_COLUMN_ID;
  const label = column.columnDef.meta?.label ?? (typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id);

  const dragHandle =
    enableReorder && !isSelect ? (
      <button
        type="button"
        aria-label={`Reorder ${label} column`}
        // size-6 = the 24px WCAG 2.5.8 target floor (axe target-size); the icon stays 14px.
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
    ) : null;

  const canResize = enableResize && column.getCanResize() && !isSelect;

  return (
    <div
      ref={setNodeRef}
      role="columnheader"
      aria-colindex={colIndex}
      aria-sort={column.getCanSort() ? ariaSort : undefined}
      data-slot="data-grid-header-cell"
      className="relative flex shrink-0 items-center bg-inherit px-3 text-xs font-medium text-muted-foreground"
      style={style}
    >
      {header.isPlaceholder ? null : isSelect ? (
        flexRender(column.columnDef.header, header.getContext())
      ) : (
        <DataGridColumnHeader column={column} grid={grid} label={label} enablePinning={enablePinning} dragHandle={dragHandle} />
      )}

      {canResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} column`}
          aria-valuenow={Math.round(header.getSize())}
          aria-valuemin={column.columnDef.minSize ?? 40}
          aria-valuemax={column.columnDef.maxSize ?? 1000}
          tabIndex={0}
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onDoubleClick={() => column.resetSize()}
          onKeyDown={(e) => applyResizeKeydown(e, column, table)}
          className={cn(
            'absolute inset-y-0 right-0 z-10 w-1 translate-x-1/2 cursor-col-resize touch-none select-none',
            // ≥24px keyboard/touch hit area straddling the edge (WCAG 2.5.8/2.5.7).
            'after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
            'hover:bg-border focus-visible:bg-primary focus-visible:outline-none',
            column.getIsResizing() && 'bg-primary',
          )}
        />
      )}
    </div>
  );
}

function BodyRow<TData extends RowData>({
  row,
  virtualStart,
  size,
  rowIndex,
  density,
  headerHeight,
  pinBorder,
  onRowClick,
}: {
  row: Row<DataGridFeatures, TData>;
  virtualStart: number;
  size: number;
  rowIndex: number;
  density: 'comfortable' | 'compact';
  headerHeight: number;
  pinBorder: boolean;
  onRowClick?: (row: TData) => void;
}) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={row.getIsSelected()}
      data-state={row.getIsSelected() ? 'selected' : undefined}
      data-slot="data-grid-row"
      className={cn(
        'absolute left-0 flex w-full items-center border-b bg-card transition-colors hover:bg-muted/50 data-[state=selected]:bg-accent',
        onRowClick && 'cursor-pointer',
      )}
      // scroll-mt keeps a focused row clear of the sticky header (WCAG 2.4.11).
      style={{ height: size, transform: `translateY(${virtualStart}px)`, scrollMarginTop: headerHeight }}
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
    >
      {row.getVisibleCells().map((cell, i) => (
        <div
          key={cell.id}
          role="gridcell"
          aria-colindex={i + 1}
          data-slot="data-grid-cell"
          // h-full caps the cell at the fixed virtual row height: without it a wrapping
          // renderer grows past the row box and its opaque bg paints over border-b.
          className={cn('flex h-full shrink-0 items-center truncate bg-inherit px-3 text-sm', density === 'compact' ? 'py-1' : 'py-2')}
          style={{ ...getColumnPinningStyle({ column: cell.column, withBorder: pinBorder }), width: cell.column.getSize() }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
    </div>
  );
}

/**
 * A non-interactive group-header row (label + contiguous count)
 * injected by `groupBy`: a full-width `rowheader` cell spanning all columns,
 * outside the row tab sequence, with an sr-only group summary for AT.
 */
function GroupHeaderRow<TData extends RowData>({
  entry,
  colCount,
  virtualStart,
  size,
  rowIndex,
  renderHeader,
}: {
  entry: { label: string; count: number };
  colCount: number;
  virtualStart: number;
  size: number;
  rowIndex: number;
  renderHeader?: GroupByConfig<TData>['renderHeader'];
}) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-slot="data-grid-group-row"
      className="absolute left-0 flex w-full items-center border-b bg-muted/50"
      style={{ height: size, transform: `translateY(${virtualStart}px)` }}
    >
      <div
        role="rowheader"
        aria-colspan={colCount}
        className="flex w-full min-w-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground"
      >
        {renderHeader ? (
          renderHeader(entry.label, entry.count)
        ) : (
          <>
            <span className="truncate">{entry.label}</span>
            <span aria-hidden>({entry.count})</span>
          </>
        )}
        <span className="sr-only">
          group, {entry.count} {entry.count === 1 ? 'item' : 'items'}
        </span>
      </div>
    </div>
  );
}

export function VirtualizedDataGrid<TData extends RowData>(props: VirtualizedDataGridProps<TData>) {
  const {
    columns,
    isLoading,
    isBusy,
    error,
    emptyState,
    errorState,
    loadingState,
    toolbar,
    actionBar,
    onRowClick,
    onRetry,
    height,
    rowCount,
    cursor,
    className,
  } = props;

  const fill = height == null;

  const augmentedColumns = React.useMemo<ColumnDef<TData>[]>(() => {
    const wantSelection = (props.features?.rowSelection ?? true) && !columns.some((c) => (c as { id?: string }).id === SELECT_COLUMN_ID);
    return wantSelection ? [makeSelectionColumn<TData>(), ...columns] : columns;
  }, [columns, props.features?.rowSelection]);

  const grid = useDataGrid<TData>({ ...props, columns: augmentedColumns });
  const { table, rowVirtualizer, displayRows, scrollRef, density, features, moveColumn, isLayoutReady, announcement, pageSizeOptions } = grid;

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const headerHeight = DENSITY_ROW_HEIGHT[density];

  const columnOrderIds = table.state.columnOrder.length ? table.state.columnOrder : table.getAllLeafColumns().map((c) => c.id);

  const totalRowCount = props.manual?.pagination ? (rowCount ?? rows.length) : table.getFilteredRowModel().rows.length;
  // Injected group headers are real grid rows on this page; count
  // them so aria-rowindex never exceeds aria-rowcount.
  const groupHeaderCount = displayRows.length - rows.length;

  // Scroll-driven affordances (Δ5): header elevation once scrolled, and the
  // pinned-column divider only while horizontally overflowing.
  const [scrolled, setScrolled] = React.useState(false);
  const [overflowX, setOverflowX] = React.useState(false);

  const onScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrolled(el.scrollTop > 0);
    setOverflowX(el.scrollWidth > el.clientWidth + 1);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setOverflowX(el.scrollWidth > el.clientWidth + 1);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, augmentedColumns.length, rows.length]);

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        moveColumn(String(active.id), String(over.id));
      }
    },
    [moveColumn],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && features.rowSelection) {
        e.preventDefault();
        table.toggleAllRowsSelected(true);
      }
    },
    [features.rowSelection, table],
  );

  const hasSelection = table.getFilteredSelectedRowModel().rows.length > 0;

  // A `role="grid"` must contain a `role="row"` child (aria-required-children).
  // The loading / error / empty states render non-row content, so wrap them in a
  // single full-span grid row/cell to keep the grid's required structure valid.
  const stateRow = (node: React.ReactNode) => (
    <div role="row" aria-rowindex={1} className="h-full">
      <div role="gridcell" aria-colindex={1} className="h-full w-full">
        {node}
      </div>
    </div>
  );

  const renderBody = () => {
    // Gate the first paint on the resolved persisted layout (Δ8) so there is no
    // default→persisted flash; also covers the initial data load.
    if (isLoading || !isLayoutReady) {
      return stateRow(loadingState ?? <DataGridSkeleton columns={augmentedColumns.length} />);
    }
    if (error) {
      return stateRow(
        errorState?.(error) ?? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center" role="alert">
            <TriangleAlert className="size-10 text-destructive" />
            <div>
              <p className="font-medium">Something went wrong</p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </div>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            )}
          </div>
        ),
      );
    }
    if (rows.length === 0) {
      return stateRow(
        emptyState ?? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
            <Inbox className="size-10 text-muted-foreground/50" />
            <p className="font-medium">No results</p>
            <p className="text-sm text-muted-foreground">There is nothing to show here yet.</p>
          </div>
        ),
      );
    }

    return (
      <>
        <div role="rowgroup" className={cn('sticky top-0 z-20 border-b bg-card transition-shadow', scrolled && 'shadow-sm')}>
          {headerGroups.map((headerGroup) => (
            <div role="row" aria-rowindex={1} key={headerGroup.id} className="flex bg-card" style={{ minHeight: headerHeight }}>
              <SortableContext items={columnOrderIds} strategy={horizontalListSortingStrategy}>
                {headerGroup.headers.map((header, i) => (
                  <HeaderCell
                    key={header.id}
                    header={header}
                    grid={grid}
                    colIndex={i + 1}
                    enableReorder={features.columnReorder}
                    enableResize={features.columnResize}
                    enablePinning={features.columnPinning}
                    pinBorder={overflowX}
                  />
                ))}
              </SortableContext>
            </div>
          ))}
        </div>

        <div role="rowgroup" style={{ height: totalSize, position: 'relative' }}>
          {virtualRows.map((virtualRow) => {
            const entry = displayRows[virtualRow.index];
            if (!entry) return null;
            if (entry.kind === 'group') {
              return (
                <GroupHeaderRow<TData>
                  key={`group-${virtualRow.index}-${entry.label}`}
                  entry={entry}
                  colCount={table.getVisibleLeafColumns().length}
                  rowIndex={virtualRow.index + 2}
                  virtualStart={virtualRow.start}
                  size={virtualRow.size}
                  renderHeader={props.groupBy?.renderHeader}
                />
              );
            }
            return (
              <BodyRow
                key={entry.row.id}
                row={entry.row}
                rowIndex={virtualRow.index + 2}
                virtualStart={virtualRow.start}
                size={virtualRow.size}
                density={density}
                headerHeight={headerHeight}
                pinBorder={overflowX}
                onRowClick={onRowClick}
              />
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div
      className={cn('@container/grid flex w-full flex-col gap-3', fill && 'min-h-0 flex-1', className)}
      data-density={density}
      data-slot="virtualized-data-grid"
    >
      {toolbar ?? <DataGridToolbar grid={grid} />}

      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToHorizontalAxis]} onDragEnd={onDragEnd}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          // The grid IS the scrollable region (no intermediate generic wrapper),
          // and it is focusable so keyboard users can scroll it — satisfying
          // both scrollable-region-focusable and aria-required-children (WCAG
          // 2.1.1 / grid must own its rows directly).
          tabIndex={0}
          role="grid"
          aria-label={props['aria-label'] ?? 'Data grid'}
          aria-rowcount={totalRowCount + 1 + groupHeaderCount}
          aria-colcount={table.getVisibleLeafColumns().length}
          aria-busy={isBusy || undefined}
          className={cn('relative overflow-auto rounded-md border bg-card', fill && 'min-h-0 flex-1')}
          style={fill ? undefined : { height: typeof height === 'number' ? `${height}px` : height }}
          onKeyDown={onKeyDown}
        >
          {renderBody()}
        </div>
      </DndContext>

      <DataGridPagination grid={grid} pageSizeOptions={pageSizeOptions} cursor={cursor} isBusy={isBusy || isLoading} />
      {actionBar && hasSelection && actionBar}

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}

VirtualizedDataGrid.Toolbar = DataGridToolbar;
VirtualizedDataGrid.Pagination = DataGridPagination;
VirtualizedDataGrid.ColumnHeader = DataGridColumnHeader;
VirtualizedDataGrid.Skeleton = DataGridSkeleton;
