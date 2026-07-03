/**
 * TASK-407 — pure display helpers for the Stores surface (bucket list +
 * bucket-detail object browser). Design source: `unbuilt-super-admin-surfaces.md`
 * §2 "Stores" (spec-only, not drawn) — objects · size · quota columns and a
 * usage-vs-quota bar on the detail view.
 */

/** Sum of object sizes (bytes); NaN-safe. */
export function objectsTotalBytes(objects: ReadonlyArray<{ key: string; size: number }>): number {
  return objects.reduce((sum, o) => sum + (Number.isFinite(o.size) ? o.size : 0), 0);
}

/** Used-of-quota percentage (0–100, clamped) or null when unlimited. */
export function quotaPct(usedBytes: number, quotaBytes?: number | null): number | null {
  if (quotaBytes == null || quotaBytes <= 0) return null;
  return Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
}

/** Last path segment of an object key ("2026/07/file.wav" → "file.wav"). */
export function fileNameOf(key: string): string {
  const segments = key.split('/');
  return segments[segments.length - 1] || key;
}

/** Keys scoped to a bucket: empty/absent `bucketIds` means "all buckets". */
export function keysForBucket<T extends object>(keys: ReadonlyArray<T>, bucketId: string): T[] {
  return keys.filter((k) => {
    const raw = (k as Record<string, unknown>).bucketIds;
    const ids = Array.isArray(raw) ? raw : [];
    return ids.length === 0 || ids.includes(bucketId);
  });
}

const BUCKET_TYPE_LABELS: Record<string, string> = {
  SYSTEM: 'System',
  CUSTOM: 'Custom',
};

/** Human label for TenantBucketType (SYSTEM/CUSTOM); echoes unknown values, em-dash for missing. */
export function bucketTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return BUCKET_TYPE_LABELS[type.toUpperCase()] ?? type;
}
