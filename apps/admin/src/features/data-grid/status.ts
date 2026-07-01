import type { StatusColorRole } from '@arcaai/ui/components/shared';
import type { FilterFn } from '@tanstack/react-table';

/** Common `resourceStatus` values across HOPE resources (soft-delete = ARCHIVED). */
export const RESOURCE_STATUS_OPTIONS = [
    { label: 'Enabled', value: 'ENABLED' },
    { label: 'Disabled', value: 'DISABLED' },
    { label: 'Suspended', value: 'SUSPENDED' },
    { label: 'Archived', value: 'ARCHIVED' },
];

export function resourceStatusRole(status?: string): StatusColorRole {
    switch ((status ?? '').toUpperCase()) {
        case 'ENABLED':
            return 'success';
        case 'DISABLED':
            return 'warning';
        // TASK-387 (#1 / F6) — operator hold; more severe than the routine DISABLED toggle.
        case 'SUSPENDED':
            return 'destructive';
        case 'ARCHIVED':
            return 'neutral';
        default:
            return 'neutral';
    }
}

export function resourceStatusLabel(status?: string): string {
    if (!status) return 'Unknown';
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

/** Client-side multi-select filter: keep rows whose value is in the selected set. */
export const multiSelectFilterFn: FilterFn<unknown> = (row, columnId, filterValue) => {
    if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
    return (filterValue as string[]).includes(String(row.getValue(columnId)));
};
