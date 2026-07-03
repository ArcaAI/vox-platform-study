/**
 * TASK-383 — Platform Dashboard (frame 10) KPI number formatting.
 *
 * Tiny presentation helper so KPI counts render with locale grouping
 * (`1847` → `1,847`) and a nullish/NaN value falls back to the em-dash the
 * design system uses for "no data" (mirrors `StatCard`'s empty rendering).
 */

const EM_DASH = '\u2014';

/** Locale-grouped integer, or an em-dash for nullish / non-finite input. */
export function formatCount(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString('en-US');
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * TASK-386 (E3/#5) — human storage size. Decimal (1000-based) units so an
 * admin-set "5 TB" quota (`5e12` bytes) renders as `5 TB`, not `4.5 TiB`.
 * Nullish / non-finite → em-dash; 1 decimal place, trailing `.0` trimmed.
 */
export function formatBytes(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return EM_DASH;
  if (value < 1000) return `${Math.round(value)} B`;
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < BYTE_UNITS.length - 1) {
    size /= 1000;
    unit += 1;
  }
  const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}
