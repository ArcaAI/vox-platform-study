'use client';

import * as React from 'react';
import { flexRender, type ColumnDef, type Header, type Row } from '@tanstack/react-table';
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

import { DataGridPagination } from './data-grid-pagination';
import { DataGridSkeleton } from './data-grid-skeleton';
import { DataGridColumnHeader } from './data-grid-column-header';
import { DataGridToolbar } from './data-grid-toolbar';
import { useDataGrid } from './use-data-grid';
import type { VirtualizedDataGridProps } from './types';

const SELECT_COLUMN_ID = 'select';

function makeSelectionColumn<TData>(): ColumnDef<TData> {
  return {
    id: SELECT_COLUMN_ID,
    size: 40,
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
    enableColumnFilter: false,
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all rows"
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
      />
    ),
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

function HeaderCell<TData>({
  header,
  enableReorder,
  enablePinning,
}: {
  header: Header<TData, unknown>;
  enableReorder: boolean;
  enablePinning: boolean;
}) {
  const column = header.column;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !enableReorder,
  });

  const sorted = column.getIsSorted();
  const ariaSort = sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none';

  const style: React.CSSProperties = {
    ...getColumnPinningStyle({ column }),
    width: header.getSize(),
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    zIndex: isDragging ? 2 : getColumnPinningStyle({ column }).zIndex,
  };

  const isSelect = column.id === SELECT_COLUMN_ID;

  const dragHandle =
    enableReorder && !isSelect ? (
      <button
        type="button"
        aria-label={`Reorder ${column.id} column`}
        className="cursor-grab text-muted-foreground/60 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring [&_svg]:size-3.5"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
    ) : null;

  return (
    <div
      ref={setNodeRef}
      role="columnheader"
      aria-sort={column.getCanSort() ? ariaSort : undefined}
      data-slot="data-grid-header-cell"
      className="flex shrink-0 items-center px-3 text-xs font-medium text-muted-foreground"
      style={style}
    >
      {header.isPlaceholder ? null : isSelect ? (
        flexRender(column.columnDef.header, header.getContext())
      ) : (
        <DataGridColumnHeader
          column={column}
          label={column.columnDef.meta?.label ?? (typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id)}
          enablePinning={enablePinning}
          dragHandle={dragHandle}
        />
      )}
    </div>
  );
}

function BodyRow<TData>({
  row,
  virtualStart,
  size,
  rowIndex,
  density,
  onRowClick,
}: {
  row: Row<TData>;
  virtualStart: number;
  size: number;
  rowIndex: number;
  density: 'comfortable' | 'compact';
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
        'absolute left-0 flex w-full items-center border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-accent',
        onRowClick && 'cursor-pointer',
      )}
      style={{ height: size, transform: `translateY(${virtualStart}px)` }}
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
    >
      {row.getVisibleCells().map((cell) => (
        <div
          key={cell.id}
          role="gridcell"
          data-slot="data-grid-cell"
          className={cn('flex shrink-0 items-center truncate px-3 text-sm', density === 'compact' ? 'py-1' : 'py-2')}
          style={{ ...getColumnPinningStyle({ column: cell.column }), width: cell.column.getSize() }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
    </div>
  );
}

export function VirtualizedDataGrid<TData>(props: VirtualizedDataGridProps<TData>) {
  const {
    columns,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
    toolbar,
    actionBar,
    onRowClick,
    onRetry,
    height = 480,
    rowCount,
    cursor,
    pageSizeOptions,
    className,
  } = props;

  const augmentedColumns = React.useMemo<ColumnDef<TData>[]>(() => {
    const wantSelection = (props.features?.rowSelection ?? true) && !columns.some((c) => (c as { id?: string }).id === SELECT_COLUMN_ID);
    return wantSelection ? [makeSelectionColumn<TData>(), ...columns] : columns;
  }, [columns, props.features?.rowSelection]);

  const grid = useDataGrid<TData>({ ...props, columns: augmentedColumns });
  const { table, rowVirtualizer, scrollRef, density, features, moveColumn } = grid;

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const columnOrderIds = table.getState().columnOrder.length ? table.getState().columnOrder : table.getAllLeafColumns().map((c) => c.id);

  const totalRowCount = props.manual?.pagination ? (rowCount ?? rows.length) : table.getFilteredRowModel().rows.length;

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

  const renderBody = () => {
    if (isLoading) {
      return loadingState ?? <DataGridSkeleton columns={augmentedColumns.length} />;
    }
    if (error) {
      return (
        errorState?.(error) ?? (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center" role="alert">
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
        )
      );
    }
    if (rows.length === 0) {
      return (
        emptyState ?? (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <Inbox className="size-10 text-muted-foreground/50" />
            <p className="font-medium">No results</p>
            <p className="text-sm text-muted-foreground">There is nothing to show here yet.</p>
          </div>
        )
      );
    }

    return (
      <div ref={scrollRef} className="relative overflow-auto" style={{ height: typeof height === 'number' ? `${height}px` : height }}>
        <div role="rowgroup" className="sticky top-0 z-10 bg-card">
          {headerGroups.map((headerGroup) => (
            <div role="row" aria-rowindex={1} key={headerGroup.id} className="flex border-b" style={{ minHeight: DENSITY_ROW_HEIGHT[density] }}>
              <SortableContext items={columnOrderIds} strategy={horizontalListSortingStrategy}>
                {headerGroup.headers.map((header) => (
                  <HeaderCell key={header.id} header={header} enableReorder={features.columnReorder} enablePinning={features.columnPinning} />
                ))}
              </SortableContext>
            </div>
          ))}
        </div>

        <div role="rowgroup" style={{ height: totalSize, position: 'relative' }}>
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <BodyRow
                key={row.id}
                row={row}
                rowIndex={virtualRow.index + 2}
                virtualStart={virtualRow.start}
                size={virtualRow.size}
                density={density}
                onRowClick={onRowClick}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={cn('flex w-full flex-col gap-2.5', className)} data-density={density} data-slot="virtualized-data-grid">
      {toolbar ?? <DataGridToolbar grid={grid} />}

      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToHorizontalAxis]} onDragEnd={onDragEnd}>
        <div
          role="grid"
          aria-label={props['aria-label'] ?? 'Data grid'}
          aria-rowcount={totalRowCount + 1}
          aria-colcount={table.getVisibleLeafColumns().length}
          className="overflow-hidden rounded-md border"
          onKeyDown={onKeyDown}
        >
          {renderBody()}
        </div>
      </DndContext>

      <DataGridPagination grid={grid} pageSizeOptions={pageSizeOptions} cursor={cursor} />
      {actionBar && hasSelection && actionBar}
    </div>
  );
}

VirtualizedDataGrid.Toolbar = DataGridToolbar;
VirtualizedDataGrid.Pagination = DataGridPagination;
VirtualizedDataGrid.ColumnHeader = DataGridColumnHeader;
VirtualizedDataGrid.Skeleton = DataGridSkeleton;
