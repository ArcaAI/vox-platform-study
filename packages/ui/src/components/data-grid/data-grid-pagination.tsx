'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/shadcn/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/shadcn/select';
import { cn } from '@/lib/utils';

import { getItemRange, getPaginationRange, getPagerRadius, type ContainerBreakpoint } from './pagination-window';
import { DEFAULT_PAGE_SIZE_OPTIONS } from './types';
import { useContainerBreakpoint } from './use-container-breakpoint';
import type { RowData } from '@tanstack/react-table';
import type { UseDataGridResult } from './use-data-grid';

export interface DataGridPaginationProps<TData extends RowData> {
  grid: UseDataGridResult<TData>;
  pageSizeOptions?: number[];
  /** Cursor-mode page info supplied by the consumer (drives Next + "of many"). */
  cursor?: { hasMore?: boolean; nextCursor?: string | null };
  /** Refetch in flight — navigators disable + `aria-busy`, chrome stays mounted (zero CLS). */
  isBusy?: boolean;
  className?: string;
}

/** Status copy drops detail as the container narrows.*/
function offsetStatus(bp: ContainerBreakpoint, r: { first: number; last: number; total: number }): string {
  if (r.total <= 0) return 'No results';
  if (bp === 'xl' || bp === 'lg') return `Showing ${r.first}\u2013${r.last} of ${r.total}`;
  if (bp === 'md') return `${r.first}\u2013${r.last} of ${r.total}`;
  return `${r.last - r.first + 1} of ${r.total}`; // sm / base: shown / total
}

function cursorStatus(bp: ContainerBreakpoint, shown: number): string {
  if (bp === 'xl' || bp === 'lg') return `Showing 1\u2013${shown} of many`;
  if (bp === 'md') return `1\u2013${shown} of many`;
  return `${shown} of many`;
}

export function DataGridPagination<TData extends RowData>({
  grid,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  cursor,
  isBusy,
  className,
}: DataGridPaginationProps<TData>) {
  const { table, queryState, setQueryState } = grid;
  const navRef = React.useRef<HTMLElement>(null);
  const { bp } = useContainerBreakpoint(navRef);

  const isCursor = queryState.pagination.mode === 'cursor';
  const pageSize = queryState.pagination.limit;

  // Client cursor stack (Δ7): remembers visited cursors so Prev works forward-only APIs.
  const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([]);
  const canPrev = cursorStack.length > 0;
  const canNext = cursor?.hasMore !== false && cursor?.nextCursor != null;

  const goCursorNext = () => {
    setCursorStack((s) => [...s, queryState.pagination.mode === 'cursor' ? queryState.pagination.cursor : null]);
    setQueryState({ ...queryState, pagination: { mode: 'cursor', cursor: cursor?.nextCursor ?? null, limit: pageSize } });
  };
  const goCursorPrev = () => {
    if (!canPrev) return;
    const prevCursor = cursorStack[cursorStack.length - 1] ?? null;
    setCursorStack((s) => s.slice(0, -1));
    setQueryState({ ...queryState, pagination: { mode: 'cursor', cursor: prevCursor, limit: pageSize } });
  };

  const setPageSize = (size: number) => {
    if (queryState.pagination.mode === 'cursor') {
      setCursorStack([]);
      setQueryState({ ...queryState, pagination: { mode: 'cursor', cursor: null, limit: size } });
    } else {
      table.setPageSize(size);
    }
  };

  const pageIndex = queryState.pagination.mode === 'offset' ? queryState.pagination.page : 0;
  const pageCount = Math.max(1, table.getPageCount());
  const total = table.getRowCount();
  const range = getItemRange({ page: pageIndex, limit: pageSize, total });
  const radius = getPagerRadius(bp);
  const showEnds = bp === 'xl';
  const numbers = isCursor ? [] : getPaginationRange({ page: pageIndex, pageCount, radius });
  const numbersHidden = numbers.length === 0;

  const shown = table.getRowModel().rows.length;
  const statusText = isCursor ? cursorStatus(bp, shown) : offsetStatus(bp, range);

  return (
    <nav
      ref={navRef}
      aria-label="Pagination"
      aria-busy={isBusy || undefined}
      className={cn('flex min-h-11 w-full items-center justify-between gap-4 whitespace-nowrap px-1', className)}
    >
      <p role="status" aria-live="polite" className="min-w-24 text-muted-foreground text-sm tabular-nums">
        {statusText}
      </p>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <p className="hidden whitespace-nowrap font-medium text-sm @md/grid:block">Rows per page</p>
          <Select value={`${pageSize}`} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-18" aria-label="Rows per page" size="sm">
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
          <div className="flex items-center gap-1">
            <Button aria-label="Previous page" variant="outline" size="icon" className="size-8" disabled={isBusy || !canPrev} onClick={goCursorPrev}>
              <ChevronLeft />
            </Button>
            <Button aria-label="Next page" variant="outline" size="icon" className="size-8" disabled={isBusy || !canNext} onClick={goCursorNext}>
              <ChevronRight />
            </Button>
          </div>
        ) : numbersHidden ? (
          <div className="flex items-center gap-2">
            <Button
              aria-label="Go to previous page"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.previousPage()}
              disabled={isBusy || !table.getCanPreviousPage()}
            >
              <ChevronLeft />
            </Button>
            <span className="font-medium text-sm tabular-nums">
              Page {pageIndex + 1} of {pageCount}
            </span>
            <Button
              aria-label="Go to next page"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.nextPage()}
              disabled={isBusy || !table.getCanNextPage()}
            >
              <ChevronRight />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {showEnds && (
              <Button
                aria-label="Go to first page"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.setPageIndex(0)}
                disabled={isBusy || !table.getCanPreviousPage()}
              >
                <ChevronsLeft />
              </Button>
            )}
            <Button
              aria-label="Go to previous page"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.previousPage()}
              disabled={isBusy || !table.getCanPreviousPage()}
            >
              <ChevronLeft />
            </Button>

            {numbers.map((item) =>
              typeof item === 'number' ? (
                <Button
                  key={item}
                  aria-label={`Go to page ${item}`}
                  aria-current={item === pageIndex + 1 ? 'page' : undefined}
                  variant={item === pageIndex + 1 ? 'outline' : 'ghost'}
                  size="icon"
                  className="size-8 tabular-nums"
                  disabled={isBusy}
                  onClick={() => table.setPageIndex(item - 1)}
                >
                  {item}
                </Button>
              ) : (
                <span key={item} aria-hidden className="flex size-8 items-center justify-center text-muted-foreground text-sm">
                  &hellip;
                </span>
              ),
            )}

            <Button
              aria-label="Go to next page"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.nextPage()}
              disabled={isBusy || !table.getCanNextPage()}
            >
              <ChevronRight />
            </Button>
            {showEnds && (
              <Button
                aria-label="Go to last page"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.setPageIndex(pageCount - 1)}
                disabled={isBusy || !table.getCanNextPage()}
              >
                <ChevronsRight />
              </Button>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
