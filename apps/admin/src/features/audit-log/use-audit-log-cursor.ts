import type { AsyncCollection } from '@arcaai/ui/lib/shared';
import { useAuditLog, type AuditLogEntry } from '@arcaai/vox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { auditCursorFilterKey, type AuditCursorFilters } from './audit-cursor-query';

/**
 * `AsyncCollection` of audit entries fed by keyset (cursor) pagination — the
 * infinite-scroll data source for the Audit Log grid (TASK-373 / TASK-374).
 *
 * Rows accumulate across pages (append on `fetchNextPage`), so the virtualized
 * grid grows as the operator pages forward. TASK-375 swap: the request now goes
 * through the SDK's `useAuditLog().listByCursor(query)` (which owns the cursor
 * endpoint path + query assembly and normalizes the server
 * `CursorPaginatedResponse` to a `CursorPageResult`), replacing the previous raw
 * `apiClient` call + local endpoint constant. The `AsyncCollection` /
 * infinite-scroll behavior is unchanged.
 */
export interface AuditLogCursorCollection extends AsyncCollection<AuditLogEntry> {
  /** Opaque keyset token for the next page (drives the grid's cursor pager). */
  nextCursor: string | null;
}

export function useAuditLogCursor(filters: AuditCursorFilters, limit: number): AuditLogCursorCollection {
  const { listByCursor } = useAuditLog();

  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const inflightRef = useRef(false);
  // Stable string key for the reset effect (filters object identity is unstable).
  const filterKey = auditCursorFilterKey(filters, limit);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const loadPage = useCallback(
    async (cursor: string | null) => {
      if (inflightRef.current) return;
      inflightRef.current = true;
      const isInitial = cursor === null;
      if (isInitial) setIsLoading(true);
      else setIsFetchingNextPage(true);
      setError(null);
      try {
        const f = filtersRef.current;
        const page = await listByCursor({
          cursor,
          limit,
          action: f.action,
          resourceType: f.resourceType,
          userId: f.userId,
          from: f.from,
          to: f.to,
        });
        setRows((prev) => (isInitial ? page.rows : [...prev, ...page.rows]));
        setNextCursor(page.nextCursor ?? null);
        setHasMore(Boolean(page.hasMore));
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inflightRef.current = false;
        setIsLoading(false);
        setIsFetchingNextPage(false);
      }
    },
    [listByCursor, limit],
  );

  // (Re)load the first page whenever the filters or page size change.
  useEffect(() => {
    setRows([]);
    setNextCursor(null);
    setHasMore(false);
    void loadPage(null);
  }, [loadPage, filterKey]);

  const fetchNextPage = useCallback(() => {
    if (hasMore && nextCursor && !inflightRef.current) void loadPage(nextCursor);
  }, [hasMore, nextCursor, loadPage]);

  const refetch = useCallback(() => {
    void loadPage(null);
  }, [loadPage]);

  return {
    data: rows,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage: hasMore,
    fetchNextPage,
    refetch,
    nextCursor,
  };
}
