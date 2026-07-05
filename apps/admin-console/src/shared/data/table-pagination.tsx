'use client';

import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { formatNumber } from '@/shared/format';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

function RowsPerPage({ limit, onLimitChange }: { limit: number; onLimitChange?: (limit: number) => void }) {
    if (!onLimitChange) return null;
    return (
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
            Rows per page:
            <select
                className="border-input bg-background focus-visible:ring-ring h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
                value={limit}
                onChange={(event) => onLimitChange(Number(event.target.value))}
            >
                {PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </select>
        </label>
    );
}

/**
 * Offset pagination footer (frame 08): rows-per-page, "Showing a–b of n",
 * prev/next. `page` is zero-based (gateway PaginatedQuery convention).
 */
export function TablePagination({
    page,
    limit,
    total,
    onPageChange,
    onLimitChange,
}: {
    page: number;
    limit: number;
    total: number;
    onPageChange: (page: number) => void;
    onLimitChange?: (limit: number) => void;
}) {
    const first = total === 0 ? 0 : page * limit + 1;
    const last = Math.min((page + 1) * limit, total);
    const lastPage = Math.max(Math.ceil(total / limit) - 1, 0);

    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
                <RowsPerPage limit={limit} onLimitChange={onLimitChange} />
                <span className="text-muted-foreground text-sm">
                    Showing {formatNumber(first)}&ndash;{formatNumber(last)} of {formatNumber(total)}
                </span>
            </div>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" aria-label="Previous page" disabled={page <= 0} onClick={() => onPageChange(page - 1)}>
                    <IconChevronLeft aria-hidden />
                    Prev
                </Button>
                <span className="text-sm tabular-nums" aria-current="page">
                    [{page + 1}]
                </span>
                <Button variant="ghost" size="sm" aria-label="Next page" disabled={page >= lastPage} onClick={() => onPageChange(page + 1)}>
                    Next
                    <IconChevronRight aria-hidden />
                </Button>
            </div>
        </nav>
    );
}

/** Keyset variant for deep scans (audit logs): prev/next over a cursor stack. */
export function CursorPagination({
    hasPrev,
    hasNext,
    onPrev,
    onNext,
    shownCount,
    onLimitChange,
    limit,
}: {
    hasPrev: boolean;
    hasNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    shownCount?: number;
    limit?: number;
    onLimitChange?: (limit: number) => void;
}) {
    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
                {limit !== undefined ? <RowsPerPage limit={limit} onLimitChange={onLimitChange} /> : null}
                {shownCount !== undefined ? <span className="text-muted-foreground text-sm">Showing {formatNumber(shownCount)} rows</span> : null}
            </div>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" aria-label="Previous page" disabled={!hasPrev} onClick={onPrev}>
                    <IconChevronLeft aria-hidden />
                    Prev
                </Button>
                <Button variant="ghost" size="sm" aria-label="Next page" disabled={!hasNext} onClick={onNext}>
                    Next
                    <IconChevronRight aria-hidden />
                </Button>
            </div>
        </nav>
    );
}
