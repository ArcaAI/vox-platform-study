'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/shadcn/select';
import { cn } from '@/lib/utils';

import type { UseDataGridResult } from './use-data-grid';

export interface DataGridPaginationProps<TData> {
  grid: UseDataGridResult<TData>;
  pageSizeOptions?: number[];
  /** Cursor mode page info (D7, inert). */
  cursor?: { hasMore?: boolean; nextCursor?: string | null };
  className?: string;
}

export function DataGridPagination<TData>({ grid, pageSizeOptions = [10, 20, 50], cursor, className }: DataGridPaginationProps<TData>) {
  const { table, queryState, setQueryState } = grid;
  const isCursor = queryState.pagination.mode === 'cursor';
  const pageSize = queryState.pagination.limit;

  return (
    <div className={cn('flex w-full flex-col-reverse items-center justify-between gap-4 p-1 sm:flex-row sm:gap-8', className)}>
      <div className="flex-1 whitespace-nowrap text-muted-foreground text-sm">
        {table.getFilteredSelectedRowModel().rows.length} of {table.getFilteredRowModel().rows.length} row(s) selected.
      </div>
      <div className="flex flex-col-reverse items-center gap-4 sm:flex-row sm:gap-6 lg:gap-8">
        <div className="flex items-center gap-2">
          <p className="whitespace-nowrap font-medium text-sm">Rows per page</p>
          <Select value={`${pageSize}`} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-18" aria-label="Rows per page">
              <SelectValue placeholder={pageSize} />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={`${size}`}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isCursor ? (
          <div className="flex items-center gap-2">
            <Button aria-label="Previous page" variant="outline" size="icon" className="size-8" disabled title="Cursor pagination is forward-only">
              <ChevronLeft />
            </Button>
            <Button
              aria-label="Next page"
              variant="outline"
              size="icon"
              className="size-8"
              disabled={cursor?.hasMore === false || cursor?.nextCursor == null}
              onClick={() =>
                setQueryState({
                  ...queryState,
                  pagination: { mode: 'cursor', cursor: cursor?.nextCursor ?? null, limit: pageSize },
                })
              }
            >
              <ChevronRight />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center font-medium text-sm">
              Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
            </div>
            <div className="flex items-center gap-2">
              <Button
                aria-label="Go to first page"
                variant="outline"
                size="icon"
                className="hidden size-8 lg:flex"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              >
                <ChevronsLeft />
              </Button>
              <Button
                aria-label="Go to previous page"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <ChevronLeft />
              </Button>
              <Button
                aria-label="Go to next page"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <ChevronRight />
              </Button>
              <Button
                aria-label="Go to last page"
                variant="outline"
                size="icon"
                className="hidden size-8 lg:flex"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
              >
                <ChevronsRight />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
