/**
 * Display formatters shared by every screen (frames 02/08: tabular numbers,
 * relative "Updated" cells, byte quotas). Dependency-free by design — built on
 * Intl so no date library enters the client bundle.
 */

const EM_DASH = '\u2014';

const numberFormat = new Intl.NumberFormat('en-US');

export function formatNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
    return numberFormat.format(value);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Binary-scaled bytes: "612 GB", "1.5 TB". Whole numbers drop the decimal. */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return EM_DASH;
    if (bytes === 0) return '0 B';
    const exponent = Math.min(Math.floor(Math.log2(Math.abs(bytes)) / 10), BYTE_UNITS.length - 1);
    const scaled = bytes / 2 ** (10 * exponent);
    const rounded = Math.round(scaled * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${BYTE_UNITS[exponent]}`;
}

function parseDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Relative time for recent instants ("5 min ago"), absolute date beyond a
 * week (rule 11 §8). `now` is injectable for tests.
 */
export function formatRelativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
    const date = parseDate(value);
    if (!date) return EM_DASH;
    const deltaSeconds = Math.round((now.getTime() - date.getTime()) / 1000);
    if (deltaSeconds < 60) return 'just now';
    const minutes = Math.floor(deltaSeconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days <= 7) return `${days} d ago`;
    return formatDateTime(date, 'date');
}

const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

export function formatDateTime(value: string | Date | null | undefined, variant: 'date' | 'datetime' = 'datetime'): string {
    const date = parseDate(value);
    if (!date) return EM_DASH;
    return variant === 'date' ? dateFormat.format(date) : dateTimeFormat.format(date);
}

/** Percentage with one optional decimal: 0.42 -> "0.42%", 18 -> "18%". */
export function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
    const rounded = Math.round(value * 100) / 100;
    return `${rounded}%`;
}
