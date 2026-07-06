import type { Column } from '@tanstack/react-table';
import { dataTableConfig } from '@/config/data-table';
import type { ExtendedColumnFilter, FilterOperator, FilterVariant } from '@/types/data-table';

export function getColumnPinningStyle<TData>({ column, withBorder = false }: { column: Column<TData>; withBorder?: boolean }): React.CSSProperties {
  const isPinned = column.getIsPinned();
  const isLastLeftPinnedColumn = isPinned === 'left' && column.getIsLastColumn('left');
  const isFirstRightPinnedColumn = isPinned === 'right' && column.getIsFirstColumn('right');

  return {
    // Divider shadow only on the boundary cell, and only when the caller reports
    // horizontal overflow (`withBorder`) — otherwise it is visual noise (Δ5).
    boxShadow: withBorder
      ? isLastLeftPinnedColumn
        ? '-4px 0 4px -4px var(--border) inset'
        : isFirstRightPinnedColumn
          ? '4px 0 4px -4px var(--border) inset'
          : undefined
      : undefined,
    left: isPinned === 'left' ? `${column.getStart('left')}px` : undefined,
    right: isPinned === 'right' ? `${column.getAfter('right')}px` : undefined,
    position: isPinned ? 'sticky' : 'relative',
    // Pinned cells inherit the row background so a selected row's `bg-accent`
    // (or hover) shows through the pinned column instead of a hardcoded surface
    // colour (Δ5). The row itself paints an opaque background so the pinned
    // cell stays opaque over horizontally-scrolling content.
    background: isPinned ? 'inherit' : undefined,
    width: column.getSize(),
    zIndex: isPinned ? 1 : undefined,
  };
}

export function getFilterOperators(filterVariant: FilterVariant) {
  const operatorMap: Record<FilterVariant, { label: string; value: FilterOperator }[]> = {
    text: dataTableConfig.textOperators,
    number: dataTableConfig.numericOperators,
    range: dataTableConfig.numericOperators,
    date: dataTableConfig.dateOperators,
    dateRange: dataTableConfig.dateOperators,
    boolean: dataTableConfig.booleanOperators,
    select: dataTableConfig.selectOperators,
    multiSelect: dataTableConfig.multiSelectOperators,
  };

  return operatorMap[filterVariant] ?? dataTableConfig.textOperators;
}

export function getDefaultFilterOperator(filterVariant: FilterVariant) {
  const operators = getFilterOperators(filterVariant);

  return operators[0]?.value ?? (filterVariant === 'text' ? 'iLike' : 'eq');
}

export function getValidFilters<TData>(filters: ExtendedColumnFilter<TData>[]): ExtendedColumnFilter<TData>[] {
  return filters.filter(
    (filter) =>
      filter.operator === 'isEmpty' ||
      filter.operator === 'isNotEmpty' ||
      (Array.isArray(filter.value) ? filter.value.length > 0 : filter.value !== '' && filter.value !== null && filter.value !== undefined),
  );
}
