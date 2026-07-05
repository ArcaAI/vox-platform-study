'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { IconArrowDown, IconArrowUp, IconArrowsSort } from '@tabler/icons-react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { cx } from '@/shared/cx';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';

export interface DataTableColumn<T> {
    key: string;
    header: ReactNode;
    cell: (row: T) => ReactNode;
    /** Server sort field (ListParams `sort` -> "field:asc|desc"). Omit = not sortable. */
    sortKey?: string;
    /** Mono cells for IDs/keys/code per frame 02. */
    mono?: boolean;
    className?: string;
    headerClassName?: string;
}

export interface DataTableProps<T> {
    'aria-label': string;
    columns: DataTableColumn<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    isLoading?: boolean;
    error?: unknown;
    onRetry?: () => void;
    /** Rendered when there are no rows and no error (icon+title+description). */
    empty?: ReactNode;
    onRowClick?: (row: T) => void;
    /** Server sort in "field:asc|desc" form, controlled by the screen. */
    sort?: string;
    onSortChange?: (sort: string) => void;
    /** Rows the loading skeleton mirrors (default 8). */
    skeletonRows?: number;
}

function nextSort(sortKey: string, current?: string): string {
    if (current === `${sortKey}:asc`) return `${sortKey}:desc`;
    return `${sortKey}:asc`;
}

function ariaSort(sortKey: string | undefined, current: string | undefined): 'ascending' | 'descending' | 'none' | undefined {
    if (!sortKey) return undefined;
    if (current === `${sortKey}:asc`) return 'ascending';
    if (current === `${sortKey}:desc`) return 'descending';
    return 'none';
}

/**
 * List/data-grid template (frame 09): semantic table, muted sticky header,
 * 44px rows, mono ID cells, row click -> detail, and the three list states —
 * loading skeleton mirroring the layout (rule 10), empty (neutral), error
 * (block state when nothing is shown; stale-data banner when rows exist).
 */
export function DataTable<T>({
    columns,
    rows,
    rowKey,
    isLoading,
    error,
    onRetry,
    empty,
    onRowClick,
    sort,
    onSortChange,
    skeletonRows = 8,
    ...props
}: DataTableProps<T>) {
    if (error && rows.length === 0 && !isLoading) {
        return <ErrorState error={error} onRetry={onRetry} />;
    }

    const showEmpty = !isLoading && !error && rows.length === 0;

    function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onRowClick?.(row);
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {error && rows.length > 0 ? <ErrorBanner error={error} onRetry={onRetry} /> : null}
            <div className="overflow-hidden rounded-md border">
                <Table aria-label={props['aria-label']}>
                    <TableHeader className="bg-muted/50 sticky top-0 z-10">
                        <TableRow className="hover:bg-transparent">
                            {columns.map((column) => {
                                const sortState = ariaSort(column.sortKey, sort);
                                return (
                                    <TableHead
                                        key={column.key}
                                        aria-sort={sortState}
                                        className={cx('text-muted-foreground h-11 text-xs font-medium', column.headerClassName)}
                                    >
                                        {column.sortKey && onSortChange ? (
                                            <button
                                                type="button"
                                                className="hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer items-center gap-1 rounded-sm outline-none focus-visible:ring-2"
                                                onClick={() => onSortChange(nextSort(column.sortKey as string, sort))}
                                            >
                                                {column.header}
                                                {sortState === 'ascending' ? (
                                                    <IconArrowUp aria-hidden className="size-3.5" />
                                                ) : sortState === 'descending' ? (
                                                    <IconArrowDown aria-hidden className="size-3.5" />
                                                ) : (
                                                    <IconArrowsSort aria-hidden className="size-3.5 opacity-50" />
                                                )}
                                            </button>
                                        ) : (
                                            column.header
                                        )}
                                    </TableHead>
                                );
                            })}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading
                            ? Array.from({ length: skeletonRows }, (_, index) => (
                                  <TableRow key={index}>
                                      {columns.map((column) => (
                                          <TableCell key={column.key} className="h-11">
                                              <Skeleton className="h-4 w-full max-w-32" />
                                          </TableCell>
                                      ))}
                                  </TableRow>
                              ))
                            : rows.map((row) => (
                                  <TableRow
                                      key={rowKey(row)}
                                      tabIndex={onRowClick ? 0 : undefined}
                                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                                      onKeyDown={onRowClick ? (event) => handleRowKeyDown(event, row) : undefined}
                                      className={cx(onRowClick && 'focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset')}
                                  >
                                      {columns.map((column) => (
                                          <TableCell key={column.key} className={cx('h-11', column.mono && 'font-mono text-xs', column.className)}>
                                              {column.cell(row)}
                                          </TableCell>
                                      ))}
                                  </TableRow>
                              ))}
                    </TableBody>
                </Table>
                {showEmpty ? <div className="border-t">{empty}</div> : null}
            </div>
        </div>
    );
}
