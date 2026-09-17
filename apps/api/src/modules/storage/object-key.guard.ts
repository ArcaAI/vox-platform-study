import { BadRequestException } from '@nestjs/common';

/**
 * TASK-983 R7 / OD-5 — shared object-key traversal guard for
 * `StorageController`.
 *
 * Every bucket's `pathPattern` is date-segmented (e.g. `{yyyy}/{MM}/{dd}`,
 * see `TenantBucketFactory.SYSTEM_BUCKET_PATH_PATTERNS`), so a legitimate
 * object key ALWAYS contains internal `/` characters
 * (`2026/09/17/file.wav`). The controller's original guard rejected any `/`
 * at all, so every real key 400'd with "Invalid file key: path traversal
 * not allowed" (the live R7 defect). This guard keeps the rejection for
 * actual traversal — a leading `/`, any backslash, or a `.`/`..`
 * path segment — while allowing internal `/`, aligning with
 * `TenantBucketService`'s object-key checks (`tenant-bucket.service.ts`
 * lines ~812/843/874), which only ever rejected `..`.
 *
 * The `:key` route param arrives ALREADY PERCENT-DECODED by Express/Nest's
 * routing layer before this guard ever sees it — a caller cannot smuggle a
 * literal `/` or `..` past this check via `%2F`/`%2e%2e` encoding.
 */
export function assertSafeObjectKey(key: string): void {
  if (!key || key.includes('\\') || key.startsWith('/')) {
    throw new BadRequestException('Invalid file key: path traversal not allowed');
  }
  const hasTraversalSegment = key.split('/').some((segment) => segment === '.' || segment === '..');
  if (hasTraversalSegment) {
    throw new BadRequestException('Invalid file key: path traversal not allowed');
  }
}
