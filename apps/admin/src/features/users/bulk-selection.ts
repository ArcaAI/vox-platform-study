import type { RowSelectionState } from '@tanstack/react-table';

/**
 * Bulk-selection helpers for the 20u action bar. The grid owns the checkboxes
 * and emits a `RowSelectionState` (`Record<id, boolean>`); the page drives that
 * state through {@link bulkSelectionReducer} so the **Clear** action can reset it
 * and the bar can read the selected ids for the (client-loop / TARGET) bulk ops.
 */

/** Ids of the currently-selected rows (drops `id: false` entries the table can emit). */
export function selectedRowIds(selection: RowSelectionState): string[] {
    return Object.keys(selection).filter((id) => selection[id]);
}

export function selectionCount(selection: RowSelectionState): number {
    return selectedRowIds(selection).length;
}

export type BulkSelectionAction = { type: 'set'; value: RowSelectionState } | { type: 'clear' };

export function bulkSelectionReducer(_state: RowSelectionState, action: BulkSelectionAction): RowSelectionState {
    switch (action.type) {
        case 'set': {
            const next: RowSelectionState = {};
            for (const [id, on] of Object.entries(action.value)) if (on) next[id] = true;
            return next;
        }
        case 'clear':
            return {};
    }
}
