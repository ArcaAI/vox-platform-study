# TASK-771 — Rate-limit admin writes answer 404 "Resource not found"

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Surfaces** | `packages/applications` (rate-limit admin service, app-settings cache) |
| **Reported** | `PUT /api/hope/admin/rate-limit/tiers/default` → `404 {"statusCode":404,"message":"Resource not found"}` from the admin console `/rate-limits` screen |

## Requirement Analysis

A SUPER_ADMIN could read the rate-limit policy but could not change any of it:
every `PUT` under `admin/rate-limit` (`enabled`, `tiers/:tier`, `routes/:routeId`)
answered 404. The rate limits are meant to be tunable at runtime without a redeploy.

## Current State Evaluation (root cause)

Reproduced end-to-end against local dev (super admin, working tenant **ArcaAI**):

| Request | Result |
|---|---|
| `GET admin/rate-limit` | 200 |
| `PUT admin/rate-limit/enabled` | 404 |
| `PUT admin/rate-limit/tiers/default` | 404 |
| `GET admin/settings/85000000-0000-0000-0000-000000000301` (a `rate-limit.*` row) | 404 |
| `GET admin/settings/85000000-0000-0000-0001-000000000001` (an ArcaAI row) | 200 |

Three defects, all on the same path:

1. **The write was tenant-scoped to the working tenant.** The BFF proxy sends
   `X-Tenant-Id: <working tenant>` for super admins, so CLS carries that tenant and
   the `tenantScopeFilter` Prisma extension filters `GlobalSetting` by it. Super-admin
   status is **not** a bypass — the extension passes through only when *no* tenant is in
   context (`tenant-scope.ts` `makeReadHandler`/`mutateWhereHandler`). The `rate-limit.*`
   rows are owned by the platform tenant `50000000-…-0000`, so `findById` missed and
   `GlobalSettingService.update` threw `DataNotFoundException` → 404. `getPolicy()` was
   unaffected because it serves the in-memory AppSettings cache, never the DB — which is
   why reads looked healthy.
2. **The post-write cache refresh poisoned the platform cache.** `cacheAppSettings()`
   loads both cache lanes from one `globalSettingRepository.findAll({})`, and that read is
   tenant-scoped the same way. Triggered in-request, it replaced the platform cache with
   only the working tenant's rows, so every platform key read as absent process-wide until
   the 45s cron (which runs outside CLS) repaired it. Observed consequence: the next write
   took the "key missing from cache" branch and **created a duplicate platform row** — which
   the boot-time duplicate-key invariant refuses to start on.
3. **A no-op field failed the whole request.** The screen submits `limit` and `ttl`
   together, so changing one sends the other unchanged; `GlobalSettingService.update` throws
   `ArgumentInvalidException` ("No changes to write to.") → 400 *after* the changed field had
   already been persisted (half-applied edit).

## Implementation

| File | Change |
|---|---|
| `services/rate-limit/rate-limit-admin.service.ts` | `writeSetting` runs the GlobalSetting write in a nested CLS scope pinned to `RATE_LIMIT_TENANT_ID` (PLATFORM-PIN — same shape as the SYSTEM-PIN in `resolveNerModelInjection`); `ClsService` injected. Also returns early when the stored value already equals the new value. |
| `services/baseServices/_meta/appSettings/appSettings.service.ts` | `cacheAppSettings()` performs its `findAll` inside `clsService.exit(...)`, so the refresh is a platform read regardless of who triggered it — the same context the 45s cron already had. |
| tests | New `appSettings.service.platform-read.test.ts`; three new cases in `rate-limit-admin.service.test.ts`. Existing `ClsService` doubles gained an `exit` pass-through. |

Both fixes were written test-first (RED → GREEN).

## Verification

- `pnpm --filter @arcaai/applications test` → 9481 passed, 1 failed. The single failure is
  `s3.service.secret-gate.test.ts`, caused by unrelated uncommitted work in
  `baseServices/storage/s3/**`; confirmed pre-existing by stashing those two files (suite
  passes) and restoring them.
- `pnpm --filter @arcaai/applications build` clean; `lint` 0 errors (warnings pre-existing).
- End-to-end as super admin with the ArcaAI working tenant selected:
  `PUT tiers/default {limit:10000,ttl:60000}` → **200**, re-submitting unchanged → **200**,
  `tiers/strict` and `routes/auth.login` → **200**, `GET admin/rate-limit` still reports
  `db` sources for every tier (cache no longer poisoned), and no duplicate rows in
  `core."GlobalSetting"`.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Root-caused and fixed the 404 (platform-tenant pin), the cache-refresh tenant scoping, and the no-op-field 400. |
