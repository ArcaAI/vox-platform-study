'use client';

/**
 * Audit-logs grid params.
 *
 * `useAdminGridParams` (shared) is offset-only, but the audit list is a keyset
 * (cursor) scan whose gateway DTO (`AuditLogCursorQuery`) whitelists ONLY the
 * discrete `from`/`to`/`action`/`resourceType`/`userId` knobs (+ cursor/limit)
 * and rejects the generic `search`/`filters`/`sort` params. So this screen-local
 * hook reuses the exported `grid-url-state` codec for the shareable state
 * (omni search / typed filters / limit live in the URL) while keeping the
 * ephemeral cursor in local state, and maps the grid's `DataQueryState` onto the
 * discrete cursor params:
 *   • omni search  → `userId`  (the actor id — the frame's primary text filter)
 *   • `action`      select filter → `action`
 *   • `resourceType`select filter → `resourceType`
 *   • `createdAt`   dateRange filter → `from`/`to` (ISO instants, day-bounded)
 *
 * It does NOT touch `shared/data` — only the exported pure helpers/parsers.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryStates } from 'nuqs';
import type { DataQueryState, FilterRule } from '@arcaai/ui';
import { DEFAULT_LIMIT, encodeFilters, filtersParser, limitParser, searchParser } from '@/shared/data/grid-url-state';
import type { AuditLog, AuditLogCursorParams, AuditLogListParams } from '../api/types';

/** Shareable audit state — cursor is ephemeral (local), everything else in the URL. */
const AUDIT_GRID_PARSERS = { search: searchParser, limit: limitParser, f: filtersParser };

/** `yyyy-MM-dd` (grid date filter) or ISO string → ISO-8601 instant; upper bound gets end-of-day. */
function toIsoInstant(value: unknown, endOfDay = false): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const iso = value.length <= 10 ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ruleValue(rule: FilterRule | undefined): string | undefined {
    const value = Array.isArray(rule?.value) ? rule?.value[0] : rule?.value;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export interface AuditGridParams {
    queryState: DataQueryState;
    setQueryState: (next: DataQueryState) => void;
    /** Cursor query for `useAuditLogsCursor`. */
    listParams: AuditLogCursorParams;
    /** Filter-only params (no cursor/limit) for the count probe + export. */
    filterParams: AuditLogListParams;
}

export function useAuditGridParams(): AuditGridParams {
    const [{ search, limit, f }, setUrlState] = useQueryStates(AUDIT_GRID_PARSERS);
    const [cursor, setCursor] = useState<string | null>(null);

    const queryState = useMemo<DataQueryState>(
        () => ({
            pagination: { mode: 'cursor', cursor, limit },
            sorting: [],
            filters: f,
            globalSearch: search.length > 0 ? search : undefined,
        }),
        [cursor, limit, f, search],
    );

    const setQueryState = useCallback(
        (next: DataQueryState) => {
            // A result-set change (filters / omni search) restarts the keyset walk.
            const changedResultSet =
                encodeFilters(next.filters) !== encodeFilters(queryState.filters) ||
                (next.globalSearch ?? '') !== (queryState.globalSearch ?? '');
            const nextCursor = changedResultSet ? null : next.pagination.mode === 'cursor' ? next.pagination.cursor : null;
            setCursor(nextCursor);

            setUrlState({
                search: next.globalSearch && next.globalSearch.length > 0 ? next.globalSearch : null,
                f: next.filters.length > 0 ? next.filters : null,
                limit: next.pagination.limit !== DEFAULT_LIMIT ? next.pagination.limit : null,
            });
        },
        [queryState, setUrlState],
    );

    const filterParams = useMemo<AuditLogListParams>(() => {
        const action = ruleValue(f.find((rule) => rule.id === 'action'));
        const resourceType = ruleValue(f.find((rule) => rule.id === 'resourceType'));
        const createdAt = f.find((rule) => rule.id === 'createdAt');
        const [fromRaw, toRaw] = Array.isArray(createdAt?.value) ? createdAt.value : [];
        const from = toIsoInstant(fromRaw);
        const to = toIsoInstant(toRaw, true);
        return {
            ...(action ? { action: action as AuditLog['action'] } : {}),
            ...(resourceType ? { resourceType } : {}),
            ...(search ? { userId: search } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
        };
    }, [f, search]);

    const listParams = useMemo<AuditLogCursorParams>(
        () => ({ ...filterParams, limit, ...(cursor ? { cursor } : {}) }),
        [filterParams, limit, cursor],
    );

    return { queryState, setQueryState, listParams, filterParams };
}
