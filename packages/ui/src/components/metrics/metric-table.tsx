'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Skeleton } from '@/components/shadcn/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/shadcn/table';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

export type MetricColumnAlign = 'left' | 'center' | 'right';
export type MetricColumnFormat = 'text' | 'numeric';

export interface MetricColumn {
  key: string;
  label: React.ReactNode;
  align?: MetricColumnAlign;
  /** `numeric` right-aligns and applies `tabular-nums` (unless `align` overrides). */
  format?: MetricColumnFormat;
}

export interface MetricTableProps extends BaseSurfaceProps, AsyncStateProps {
  columns: MetricColumn[];
  /** Pre-rendered cell nodes keyed by column key (status cells = `<StatusBadge/>`). */
  rows: Record<string, React.ReactNode>[];
  caption?: React.ReactNode;
  getRowId?: (row: Record<string, React.ReactNode>, index: number) => string;
  /** Zebra striping via the `--muted` token. */
  zebra?: boolean;
  /** Skeleton row count while loading (default 5). */
  skeletonRows?: number;
  'aria-label'?: string;
}

const ALIGN_CLASS: Record<MetricColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** Right-align + `tabular-nums` for numeric columns; honor an explicit `align`. */
function columnClass(col: MetricColumn): string {
  const numeric = col.format === 'numeric';
  const align = col.align ?? (numeric ? 'right' : 'left');
  return cn(ALIGN_CLASS[align], numeric && 'tabular-nums');
}

/**
 * Compact metrics table (PHASE-2-PLAN A thin, semantic wrapper over the
 * shadcn `Table` primitives (NOT `VirtualizedDataGrid` — these are small, fixed
 * metric rows). Real `<th scope="col">` headers + `<caption>`, numeric columns get
 * `tabular-nums` + right alignment, and it honors the `AsyncStateProps`
 * loading/empty/error contract. Cells are pre-rendered nodes, so callers pass a
 * `<StatusBadge/>` for status columns.
 */
export function MetricTable({
  columns,
  rows,
  caption,
  getRowId,
  zebra = false,
  skeletonRows = 5,
  density = 'comfortable',
  className,
  isLoading,
  error,
  emptyState,
  errorState,
  loadingState,
  ...props
}: MetricTableProps) {
  const ariaLabel = props['aria-label'];
  const cellPad = density === 'compact' ? 'py-1.5' : 'py-3';
  const colCount = columns.length;

  let body: React.ReactNode;
  if (isLoading && rows.length === 0) {
    body = (
      <TableBody>
        {loadingState ? (
          <TableRow>
            <TableCell colSpan={colCount}>{loadingState}</TableCell>
          </TableRow>
        ) : (
          Array.from({ length: skeletonRows }).map((_, r) => (
            <TableRow key={r} data-slot="metric-table-skeleton-row">
              {columns.map((col) => (
                <TableCell key={col.key} className={cn(columnClass(col), cellPad)}>
                  <Skeleton className="h-4 w-full max-w-24" />
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    );
  } else if (error && rows.length === 0) {
    body = (
      <TableBody>
        <TableRow>
          <TableCell colSpan={colCount} className="py-8">
            {errorState?.(error) ?? (
              <div data-slot="metric-table-error" role="alert" className="flex flex-col items-center gap-1 text-center">
                <TriangleAlert className="size-6 text-destructive" />
                <span className="text-sm text-muted-foreground">{error.message}</span>
              </div>
            )}
          </TableCell>
        </TableRow>
      </TableBody>
    );
  } else if (rows.length === 0) {
    body = (
      <TableBody>
        <TableRow>
          <TableCell colSpan={colCount} className="py-8">
            <div data-slot="metric-table-empty" className="text-center text-sm text-muted-foreground">
              {emptyState ?? 'No data to display.'}
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    );
  } else {
    body = (
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={getRowId?.(row, index) ?? index} className={cn(zebra && 'even:bg-muted/40')}>
            {columns.map((col) => (
              <TableCell key={col.key} data-col={col.key} className={cn(columnClass(col), cellPad)}>
                {row[col.key]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    );
  }

  return (
    <div data-slot="metric-table" data-density={density} className={className}>
      <Table aria-label={ariaLabel}>
        {caption ? <TableCaption>{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} data-col={col.key} scope="col" className={cn(columnClass(col), cellPad)}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {body}
      </Table>
    </div>
  );
}
