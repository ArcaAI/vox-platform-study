/**
 * Shared storage-URI parsing.
 *
 * `MediaEntity.uri` is written by `StorageController.uploadFile` in the
 * canonical `s3://<bucket>/<key>` form. Every consumer that needs to turn a
 * `Media` row back into a `{ bucket, key }` pair for `IBlobStorageService`
 * (presigned GET, raw object fetch, ...) MUST go through this single parser
 * instead of hand-rolling its own regex — previously `context.service.ts`
 * and `text-proxy.controller.ts` each carried an identical private copy, which
 * is exactly the kind of duplication that lets one copy silently drift from
 * the other.
 */

/**
 * Parse a `MediaEntity.uri` of the canonical `s3://<bucket>/<key>` form
 * (written by `StorageController` on upload) into a provider-agnostic
 * `{ bucket, key }` for `IBlobStorageService`. Returns `null` for any other
 * shape (e.g. legacy absolute URLs, `null`/`undefined`) so callers degrade to
 * "no url" / "skip" instead of throwing.
 */
export function parseStorageUri(uri: string | null | undefined): { bucket: string; key: string } | null {
  if (!uri) {
    return null;
  }
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    return null;
  }
  return { bucket: match[1], key: match[2] };
}
