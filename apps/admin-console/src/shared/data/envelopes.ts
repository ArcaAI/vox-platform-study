/**
 * List-envelope normalizers (TASK-423, Phase 4).
 *
 * Console gateway endpoints ship several pagination envelope shapes. This maps
 * each to the `@arcaai/ui` `PageResult<T>` the grid consumes, computing
 * `totalPages`/`hasMore` when the raw envelope omits them.
 *
 * Handled shapes:
 *   - `{ data, count, limit, page }`     — standard offset (PaginatedResponse)
 *   - `{ data, count, page, limit }`     — same, key order irrelevant
 *   - `{ data, total, totalPages }`      — SDK-style (no page/limit)
 *   - `{ data, total, page, pageSize }`  — pageSize alias for limit
 *   - `{ items, total }`                 — items alias for data
 *   - `{ data, nextCursor, hasMore, limit }` — keyset cursor envelope
 */

import type { PageResult } from '@arcaai/ui';

export interface NormalizeListOptions {
    /** Set to 1 when the envelope's `page` is 1-based; normalized to internal 0-based. */
    pageBase?: 0 | 1;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeList<T = unknown>(raw: unknown, opts?: NormalizeListOptions): PageResult<T> {
    if (!raw || typeof raw !== 'object') return { rows: [] };
    const record = raw as Record<string, unknown>;

    const rows = (Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.items)
          ? record.items
          : Array.isArray(raw)
            ? raw
            : []) as T[];

    // Cursor envelope — detected by the presence of `nextCursor`.
    if ('nextCursor' in record) {
        const nextCursor = (record.nextCursor ?? null) as string | null;
        return {
            rows,
            limit: finiteNumber(record.limit),
            hasMore: typeof record.hasMore === 'boolean' ? record.hasMore : nextCursor !== null,
            nextCursor,
        };
    }

    const pageBase = opts?.pageBase ?? 0;
    const total = finiteNumber(record.count) ?? finiteNumber(record.total);
    const limit = finiteNumber(record.limit) ?? finiteNumber(record.pageSize);
    const rawPage = finiteNumber(record.page);
    const page = rawPage === undefined ? undefined : pageBase === 1 ? Math.max(0, rawPage - 1) : rawPage;

    const totalPages =
        finiteNumber(record.totalPages) ?? (total !== undefined && limit !== undefined && limit > 0 ? Math.ceil(total / limit) : undefined);

    const hasMore =
        typeof record.hasMore === 'boolean'
            ? record.hasMore
            : total !== undefined && limit !== undefined && page !== undefined && limit > 0
              ? (page + 1) * limit < total
              : undefined;

    return { rows, total, page, limit, totalPages, hasMore };
}
