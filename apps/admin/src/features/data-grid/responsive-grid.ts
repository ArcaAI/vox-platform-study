import type { ColumnDef } from '@tanstack/react-table';

/**
 * Pure helpers behind the responsive data-grid wrapper (TASK-384). Kept free of
 * any `@arcaai/ui` / `@arcaai/vox` runtime import so they're unit-testable under
 * the admin vitest config (which stubs those packages). Type-only imports are
 * erased at compile time.
 */

/** Stable column id: explicit `id` wins, else the `accessorKey`. */
export function getColumnId<TData>(col: ColumnDef<TData>): string | undefined {
    if (col.id) return col.id;
    const accessorKey = (col as { accessorKey?: unknown }).accessorKey;
    return accessorKey == null ? undefined : String(accessorKey);
}

/**
 * Tablet "condensed" table: keep only the columns whose id is in `keepIds`,
 * preserving the original column order. `keepIds` empty/undefined → all columns
 * (no-op, so callers without a priority list degrade to the full table).
 */
export function selectCondensedColumns<TData>(columns: ColumnDef<TData>[], keepIds?: readonly string[]): ColumnDef<TData>[] {
    if (!keepIds || keepIds.length === 0) return columns;
    const keep = new Set(keepIds);
    return columns.filter((c) => {
        const id = getColumnId(c);
        return id != null && keep.has(id);
    });
}

export interface PaginationSummary {
    /** 1-based index of the first row on the page (0 when empty). */
    from: number;
    /** 1-based index of the last row on the page (0 when empty). */
    to: number;
    total: number;
    /** Clamped 0-based page index. */
    page: number;
    pageCount: number;
    canPrev: boolean;
    canNext: boolean;
}

/**
 * Derive the mobile pager's "from–to of total" label and prev/next flags from a
 * 0-based page index (TanStack convention), page size and total row count.
 * Defensive: clamps the page into range and tolerates zero/negative inputs.
 */
export function paginationSummary(page: number, limit: number, total: number): PaginationSummary {
    const safeLimit = Math.max(1, Math.floor(limit) || 1);
    const safeTotal = Math.max(0, Math.floor(total) || 0);
    const pageCount = Math.max(1, Math.ceil(safeTotal / safeLimit));
    const clampedPage = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1);
    const from = safeTotal === 0 ? 0 : clampedPage * safeLimit + 1;
    const to = safeTotal === 0 ? 0 : Math.min(safeTotal, (clampedPage + 1) * safeLimit);
    return {
        from,
        to,
        total: safeTotal,
        page: clampedPage,
        pageCount,
        canPrev: clampedPage > 0,
        canNext: clampedPage < pageCount - 1,
    };
}
