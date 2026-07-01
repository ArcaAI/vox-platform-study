import type { User } from '@arcaai/vox';
import { deriveUserStatus, userTypeLabel } from './user-query';

/**
 * CSV export-row builder for the 20u toolbar **Export** + the bulk **Export**
 * action. CSV is the REAL near-term format (Excel/PDF are TARGET). Department
 * ids are resolved to names from the page's lookup; an unknown id is dropped.
 */
export interface UserExportRow {
    username: string;
    email: string;
    type: string;
    status: string;
    departments: string;
    id: string;
}

type DeptLookup = Map<string, string> | Record<string, string>;

function lookupDept(lookup: DeptLookup, id: string): string | undefined {
    return lookup instanceof Map ? lookup.get(id) : lookup[id];
}

export function buildUserExportRows(users: User[], deptNameById: DeptLookup): UserExportRow[] {
    return users.map((u) => ({
        username: u.username,
        email: u.email ?? '',
        type: userTypeLabel(u.isServiceAccount),
        status: deriveUserStatus(u).label,
        departments: (u.departmentIds ?? [])
            .map((id) => lookupDept(deptNameById, id))
            .filter((name): name is string => Boolean(name))
            .join('; '),
        id: u.id,
    }));
}

const CSV_COLUMNS: { key: keyof UserExportRow; label: string }[] = [
    { key: 'username', label: 'Username' },
    { key: 'email', label: 'Email' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'departments', label: 'Departments' },
    { key: 'id', label: 'ID' },
];

/** RFC-4180 quoting: wrap in quotes and double internal quotes when the cell has a comma/quote/newline. */
function csvCell(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toUserCsv(users: User[], deptNameById: DeptLookup): string {
    const rows = buildUserExportRows(users, deptNameById);
    const header = CSV_COLUMNS.map((c) => c.label).join(',');
    const body = rows.map((row) => CSV_COLUMNS.map((c) => csvCell(String(row[c.key] ?? ''))).join(','));
    return [header, ...body].join('\r\n');
}
