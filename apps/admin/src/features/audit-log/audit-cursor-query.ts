/**
 * Cursor audit-log filter helpers (TASK-373 / TASK-374, TASK-375 swap).
 *
 * The cursor request itself is now issued by the SDK's
 * `useAuditLog().listByCursor(query)` (it owns the `/admin/audit-logs/cursor`
 * path + query-string assembly), so this module only holds the app-level filter
 * shape and a stable key derived from it. Pure + dependency-free so the key
 * assembly is unit-testable.
 */

/** Server-side filters pushed to the `where` clause (mirrors the SDK `AuditLogCursorParams` filter subset). */
export interface AuditCursorFilters {
  action?: string;
  resourceType?: string;
  userId?: string;
  /** ISO-8601 boundary. */
  from?: string;
  /** ISO-8601 boundary. */
  to?: string;
}

/**
 * Stable string key for the filter set + page size. Drives the cursor hook's
 * reset effect (the `filters` object identity is unstable across renders, so a
 * derived primitive key is used as the effect dependency). Order-independent and
 * normalizes missing fields to `''` so equivalent filter sets compare equal.
 */
export function auditCursorFilterKey(filters: AuditCursorFilters, limit: number): string {
  return JSON.stringify({
    limit,
    action: filters.action ?? '',
    resourceType: filters.resourceType ?? '',
    userId: filters.userId ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
  });
}
