export { cn } from '@arcaai/ui/lib/utils';

/** Roles that may reach the admin console (server enforces per-tenant/CASL scope). */
const ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'];

export function isAdminRole(roles: string[] | undefined): boolean {
    if (!roles) return false;
    return roles.some((r) => ADMIN_ROLES.includes(r));
}

export function initialsOf(name: string | undefined | null): string {
    if (!name) return '?';
    const parts = name.trim().split(/[\s.@_-]+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Locale date-time, tolerant of null/invalid ISO strings (renders an em dash). */
export function formatDateTime(value?: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
}

/** Seconds → compact "1d 3h" / "3h 12m" / "5m" / "42s" uptime label. */
export function formatUptime(seconds?: number | null): string {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.floor(seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}
