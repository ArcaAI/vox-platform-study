/** Shared formatting helpers for the harness admin screens (TASK-330 Phase 6). */

/** Absolute local date-time, or an em-dash for empty values. */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

/** A compact human duration from seconds (e.g. `2h 5m`, `45s`, `3d 4h`). */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Render a threshold fraction as a percentage (e.g. `0.8` → `80%`). */
export function formatPercent(fraction?: number | null): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

/** Short, non-PHI id preview — never the full UUID (e.g. `a1b2c3d4…`). */
export function shortId(id?: string | null): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
