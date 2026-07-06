/**
 * Server-persisted grid layout adapter (TASK-423, Phase 4).
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

export function createGridLayoutPersistenceAdapter(): GridLayoutPersistenceAdapter {
    let warnedOversize = false;

    return {
        async load(namespace: string, key: string): Promise<GridLayoutState | null> {
            try {
                const rows = await getJson<UserSettingRow[]>('user/me/settings');
                if (!Array.isArray(rows)) return null;
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
export const sharedGridLayoutPersistence: GridLayoutPersistenceAdapter = createGridLayoutPersistenceAdapter();

/**
 * Build the `persistence` config for a grid id under the `ui.data-grid`
 * namespace. Use on any personalizable list — including fixed-height embedded
 * grids (`height` and persistence are orthogonal: layout is keyed by `gridId`,
 * not by the URL query-state, so multiple grids on one route never collide).
 */
export function gridPersistence(gridId: string, enabled = true) {
    return { key: gridId, namespace: UI_DATA_GRID_NAMESPACE, adapter: sharedGridLayoutPersistence, enabled };
}
