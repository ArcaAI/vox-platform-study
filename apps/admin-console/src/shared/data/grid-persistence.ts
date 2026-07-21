/**
 * Server-persisted grid layout adapter.
 *
 * Implements the `@arcaai/ui` `GridLayoutPersistenceAdapter` port over the
 * existing per-user settings BFF endpoints:
 *   - load  → `GET  user/me/settings`  (find the `ui.data-grid/<gridId>` row)
 *   - save  → `PATCH user/me/settings/ui.data-grid/<gridId>`
 *
 * It lives in `shared/data` (not a feature module) and talks to the shared HTTP
 * core directly. Both operations are BEST-EFFORT: personalization must never
 * break a screen, so load returns `null` on any miss/error and save swallows
 * failures. The gateway rejects `ui.data-grid` values over 16KB (409/400), so
 * an oversized layout is skipped client-side instead of round-tripping a reject.
 *
 * The settings read is DEDUPED: every grid on a page (and Strict
 * Mode's dev double-mount) shares one in-flight GET, and the row list is cached
 * for a short TTL (matching the app-wide 30s query staleTime) since the GET
 * gates each grid's first paint (`isLayoutReady`). A successful save
 * invalidates the cache so another screen's grid sees the new layout; a failed
 * load is never cached, so the next load retries.
 */

import type { GridLayoutPersistenceAdapter, GridLayoutState } from '@arcaai/ui';
import { getJson, patchJson } from '@/shared/api/http';

/** Namespace the gateway validates the `ui.data-grid` 16KB JSON contract under. */
export const UI_DATA_GRID_NAMESPACE = 'ui.data-grid';

/** Max serialized bytes the gateway accepts for a `ui.data-grid` value. */
export const UI_DATA_GRID_MAX_BYTES = 16384;

/** Minimal shape of a `GET user/me/settings` row (a subset of the feature `UserSetting`). */
interface UserSettingRow {
    namespace?: string;
    key: string;
    value: string;
}

const encoder = new TextEncoder();

/** Cache lifetime for the settings row list (mirrors the QueryClient staleTime). */
export const SETTINGS_CACHE_TTL_MS = 30_000;

export function createGridLayoutPersistenceAdapter(): GridLayoutPersistenceAdapter & { invalidate: () => void } {
    let warnedOversize = false;
    /** One GET shared by all concurrent loads (N grids mounting on one page). */
    let pending: Promise<UserSettingRow[]> | null = null;
    let cached: { rows: UserSettingRow[]; at: number } | null = null;
    /** Bumped by invalidate(): an in-flight GET from a previous identity must not populate the cache. */
    let generation = 0;

    async function fetchRows(): Promise<UserSettingRow[]> {
        if (cached && Date.now() - cached.at <= SETTINGS_CACHE_TTL_MS) return cached.rows;
        if (!pending) {
            const startedGeneration = generation;
            const request = getJson<UserSettingRow[]>('user/me/settings')
                .then((rows) => {
                    const list = Array.isArray(rows) ? rows : [];
                    if (startedGeneration === generation) cached = { rows: list, at: Date.now() };
                    return list;
                })
                .finally(() => {
                    // Success is served from `cached`; failure must not stick, so
                    // the in-flight slot clears either way and the next load
                    // retries (unless invalidate() already replaced it).
                    if (pending === request) pending = null;
                });
            pending = request;
        }
        return pending;
    }

    return {
        /** Drop cache + in-flight read — the session identity changed. */
        invalidate(): void {
            generation += 1;
            cached = null;
            pending = null;
        },

        async load(namespace: string, key: string): Promise<GridLayoutState | null> {
            try {
                const rows = await fetchRows();
                const row = rows.find((entry) => entry?.namespace === namespace && entry?.key === key);
                if (!row || typeof row.value !== 'string') return null;
                return JSON.parse(row.value) as GridLayoutState;
            } catch {
                return null;
            }
        },

        async save(namespace: string, key: string, state: GridLayoutState): Promise<void> {
            const serialized = JSON.stringify(state);
            if (encoder.encode(serialized).length > UI_DATA_GRID_MAX_BYTES) {
                if (!warnedOversize) {
                    warnedOversize = true;
                    console.warn(
                        `[grid-persistence] layout "${key}" exceeds the ${UI_DATA_GRID_MAX_BYTES}B cap; skipping server save (personalization stays in-memory).`,
                    );
                }
                return;
            }
            try {
                await patchJson(`user/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, { value: serialized });
                // The server rows changed — drop the cache so the next screen's
                // grid loads the layout just saved here.
                cached = null;
            } catch {
                // Best-effort: a failed persist must never surface to the grid.
            }
        },
    };
}

/**
 * One adapter instance per client session — a stable ref shared by every grid
 * so the persistence load/save effect never churns and the `GET user/me/settings`
 * read is issued through a single code path. Both `AdminDataGrid` and screens
 * that render `VirtualizedDataGrid` directly (fixed-height embedded lists) use it.
 */
const sharedAdapter = createGridLayoutPersistenceAdapter();
export const sharedGridLayoutPersistence: GridLayoutPersistenceAdapter = sharedAdapter;

/**
 * Drop the shared settings cache. Session flows call this next to
 * `queryClient.invalidateQueries()` whenever the caller IDENTITY changes
 * (impersonation start/revoke, login) — the cached rows belong to the previous
 * user. A working-tenant switch keeps the same user, and `user/me/settings`
 * is user-keyed, so it does not need this.
 */
export function invalidateGridLayoutCache(): void {
    sharedAdapter.invalidate();
}

/**
 * Build the `persistence` config for a grid id under the `ui.data-grid`
 * namespace. Use on any personalizable list — including fixed-height embedded
 * grids (`height` and persistence are orthogonal: layout is keyed by `gridId`,
 * not by the URL query-state, so multiple grids on one route never collide).
 */
export function gridPersistence(gridId: string, enabled = true) {
    return { key: gridId, namespace: UI_DATA_GRID_NAMESPACE, adapter: sharedGridLayoutPersistence, enabled };
}
