import { RequestMethod } from '@nestjs/common';
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
 * `exclude:` list for `setGlobalPrefix`. See `main.ts` for why each entry is
 * excluded (v1-compat TEXT/STT shims that must keep their literal paths).
 */
export const API_GLOBAL_PREFIX_OPTIONS: GlobalPrefixOptions = {
  exclude: [
    '/metrics',
    // v1-compat TEXT summary shims. Excluded from the `api/v1`
    // global prefix so `@Controller('api/smr/api/v1')` yields the LITERAL v1
    // paths existing clients already call, instead of being
    // rewritten to `/api/v1/api/smr/api/v1/...`.

    // v1-compatibility
    { path: 'api/smr/api/v1/summary/sync', method: RequestMethod.POST },
    { path: 'api/smr/api/v1/presummary', method: RequestMethod.POST },
    { path: 'api/stt/start_session', method: RequestMethod.POST },
    { path: 'api/stt/stop_session', method: RequestMethod.POST },
    { path: 'api/stt/switch', method: RequestMethod.POST },
  ],
};
