import type { GlobalPrefixOptions } from '@nestjs/common/interfaces';

/**
 * The gateway's global HTTP prefix, extracted from `main.ts` so it can be
 * reused by anything that needs to mirror the LIVE route surface without
 * booting an HTTP listener (e.g. `scripts/emit-openapi.ts`).
 *
 * `main.ts` calls `app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS)`
 * with these exact values — keep this file and `main.ts` in sync by import,
 * never by copy, or the offline OpenAPI document silently drifts from the
 * routes the running gateway actually serves.
 */
export const API_GLOBAL_PREFIX = 'api/v1';

/**
 * `exclude:` list for `setGlobalPrefix`.
 */
export const API_GLOBAL_PREFIX_OPTIONS: GlobalPrefixOptions = {
  exclude: ['/metrics'],
};
