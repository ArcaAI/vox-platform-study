/**
 * The MODEL STORE read plane — object storage, addressed by bucket NAME through
 * `/storage/*` on the gateway.
 *
 * A deliberate, minimal COPY of the two reads this tab needs, not an import:
 * rule 13 §Structure says features never import each other, and
 * `features/storage-browser` owns the general object browser (upload, presign,
 * delete). This module never writes, so it stays small and has little surface
 * to drift on. The authoritative object browser remains `/storage`.
 */

import { getJson } from '@/shared/api';

/** GET /storage/buckets rows — a plain array, not paginated. */
export interface ModelStoreBucket {
  name: string;
  creationDate?: string;
}

/** GET /storage/buckets/:name/files rows. `prefix` is the only server-side filter. */
export interface ModelStoreObject {
  key: string;
  size: number;
  lastModified?: string;
}

export function listModelStoreBuckets(): Promise<ModelStoreBucket[]> {
  return getJson('storage/buckets');
}

export function listModelStoreObjects(bucketName: string, prefix?: string): Promise<ModelStoreObject[]> {
  return getJson(`storage/buckets/${encodeURIComponent(bucketName)}/files`, { prefix: prefix || undefined });
}

/**
 * Pick the bucket a model store most likely lives in, FROM THE LIST THE SERVER
 * RETURNED.
 *
 * This is a UI pre-selection, not a configuration default — it never invents a
 * bucket name and never sends one the server did not list, so it cannot become
 * the "hardcoded configuration" the platform rules forbid. If nothing matches,
 * the operator picks from the same list.
 */
export function preferredModelStoreBucket(buckets: readonly ModelStoreBucket[]): string | null {
  return buckets.find((bucket) => bucket.name.toLowerCase().includes('model'))?.name ?? buckets[0]?.name ?? null;
}
