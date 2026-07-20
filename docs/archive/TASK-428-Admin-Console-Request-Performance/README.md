# TASK-428 — Admin Console Request Performance

- **Status**: Review
- **Type**: refactor (performance)
- **Owner**: admin-console (+ `packages/ui` consumer path via config only)
- **Related**: TASK-423 (Data Grid Standardization — introduced the grid layout persistence adapter), TASK-415 (Hope Admin Console)

## Requirement Analysis

User observed `GET /api/hope/user/me/settings` firing multiple times when opening pages. Investigation (this ticket's Phase 2) traced it to the TASK-423 grid-layout persistence adapter and surfaced three adjacent request-efficiency gaps. Approved scope — four changes:

1. **Deduplicate the grid-layout settings read.** Every personalizable grid mount calls `sharedGridLayoutPersistence.load()`, which issues a full `GET user/me/settings` per grid (and per Strict-Mode remount in dev). The GET also gates grid first paint (`isLayoutReady`), so it is on the critical rendering path. Requirement: one request per page load shared by all concurrent/near-term loads, invalidated when a layout save changes server state.
2. **Stop retrying 4xx responses.** The app-wide QueryClient uses `retry: 1`, which replays deterministic client errors (400/403/404…). Dev log evidence: `tenant/me`, `entitlements/me`, `tenant/me/config`, `user/me/preferences`, `admin/rbac/roles` each fired twice with 400s. Requirement: retry once on network/5xx only.
3. **`placeholderData: keepPreviousData` on paginated grid list hooks.** No hook uses it, so every page/sort/filter change drops rows to a skeleton and remounts the grid body, although `AdminDataGrid` already ships the `isBusy` affordance for exactly this transition (zero-CLS design goal).
4. **Barrel-import optimization.** 40 files import from the `@arcaai/ui` root barrel (~450 export lines incl. heavy registries); with `transpilePackages` this bloats the dev module graph (833–1251 ms first-hit route compiles in the log). Requirement: `experimental.optimizePackageImports: ['@arcaai/ui']` in `next.config.ts`.

Out of scope (noted as follow-ups): bumping `useSession`/`usePermissions` staleTime; `?namespace=` filter on `GET /user/me/settings` (gateway); bundle-analyzer pass / `next/dynamic` splitting.

## Current State Evaluation

- `apps/admin-console/src/shared/data/grid-persistence.ts` — `createGridLayoutPersistenceAdapter().load()` fetches the full settings list per call; `sharedGridLayoutPersistence` is a module singleton but does no in-flight dedup or caching. Save is debounced (600 ms in `packages/ui` `use-grid-layout.ts`), 16 KB-guarded, best-effort.
- `apps/admin-console/src/shared/providers.tsx` — `QueryClient` defaults `{ staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }`; `retry: 1` applies to all failures including 4xx.
- List hooks (`src/features/*/api/hooks.ts`) — server-driven grid hooks key on `params` but set no `placeholderData`.
- `apps/admin-console/next.config.ts` — `transpilePackages: ['@arcaai/ui']`, no `optimizePackageImports`.
- Baseline behavior is locked by existing suites: `src/shared/data/__tests__/grid-persistence.test.ts`, per-feature hooks/screen tests.

## Implementation Plan

TDD per change (RED → GREEN), then full verify:

1. `grid-persistence.ts` dedup/cache: failing tests first — concurrent `load()`s share one GET; loads within a 30 s TTL serve from cache; a successful `save()` invalidates the cache; a failed load is not cached (next load retries). Implement with a shared in-flight promise + `{ rows, at }` snapshot (TTL matches the app's 30 s `staleTime`).
2. `providers.tsx` retry predicate: failing unit test for an exported `shouldRetryQuery(failureCount, error)` — no retry on `GatewayError` 4xx, one retry on 5xx/network errors. Wire into the QueryClient.
3. `keepPreviousData`: representative failing hook test (tenants) asserting previous rows remain while a params change refetches; then apply `placeholderData: keepPreviousData` to all server-driven list hooks backing grids.
4. `next.config.ts`: add `experimental.optimizePackageImports: ['@arcaai/ui']`; verify with a production build.
5. Verify: `pnpm --filter @arcaai/admin-console test`, `lint`, `build`; capture evidence; update `docs/development-patterns-and-standards.md` §3.6 sentence about the adapter.

## Implementation Summary

All four changes landed, TDD (each new test seen RED before its implementation):

### 1. Settings-GET dedup + cache — `src/shared/data/grid-persistence.ts`

`createGridLayoutPersistenceAdapter` now keeps a shared in-flight promise plus a 30 s row-list cache (`SETTINGS_CACHE_TTL_MS`, mirroring the app `staleTime`): N grids mounting on one page (and Strict Mode's dev double-mount) share ONE `GET user/me/settings`. A successful `save()` drops the cache (cross-screen layout consistency); a failed load is never cached (next load retries). Because the singleton caches per browser session, a new exported `invalidateGridLayoutCache()` is called on identity changes so cached rows never leak across users:

- `src/shared/layout/session-banners.tsx` (`useSessionAction` — impersonation revoke / working-tenant clear via banner)
- `src/features/users/api/hooks.ts` (`useImpersonateUser`, `useRevokeImpersonation`)
- `src/features/auth/components/login-form.tsx` (`finishLogin` — soft navigation keeps module state alive)

A generation counter guards the race where an in-flight GET from the previous identity resolves after `invalidate()`. (Working-tenant switches keep the same user and the endpoint is user-keyed, so the tenant-switcher does not need it; the banner path shares `useSessionAction` with revoke and invalidating there is harmless.)

### 2. Retry predicate — `src/shared/api/query-retry.ts` (new), wired in `src/shared/providers.tsx`

`retryQuery(failureCount, error)`: one retry for network errors/5xx, never for `GatewayError` 4xx (deterministic; replaying doubles request count — dev-log evidence in Requirement Analysis). 401 also excluded: the BFF proxy owns the single-flight refresh+retry. Exported from `@/shared/api`.

### 3. `placeholderData: keepPreviousData` — all params-keyed list hooks

Rows stay rendered during page/sort/filter/search transitions (`isPlaceholderData`/`isFetching` drive the grid's existing `isBusy` affordance — zero CLS, no skeleton flash). Applied in 15 hook files: tenants (`useTenants`, `useTenantConfigs`), users (`useUsers`, `useUsersByTenant`, `useUserApiKeys`), rbac (`useRoles`, `usePolicies`), api-keys (`useApiKeys`), settings (`useGlobalSettings`, `useTenantScopedSettings`), ai-models (`useModelsPaginated`), audit-logs (`useAuditLogs`, `useAuditLogsCursor`, `useResourceAuditLogs`, `useUserAuditLogs`), consultations (`useConsultations`), dna-writing-styles (`useDnaReports`), transcription-jobs (`useTranscriptionJobs`), harness-ops (`useHarnessAudit`, `useEvalRuns`, `useHarnessWorkflows`), agents (`useTemplates`, `useUsageRecords`), departments (`useDepartments`, `useDepartmentUsers`), account (`useMyTenantConfigs`), queues (`useJobs`). Fixed-key list hooks (queues/schedulers/plans/buckets…) were left untouched — their queryKey never changes, so the option is a no-op.

### 4. Barrel-import optimization — `next.config.ts`

`experimental.optimizePackageImports: ['@arcaai/ui']` (verified against the bundled Next 16.3 docs; Turbopack supported — dev server logs `Experiments: · optimizePackageImports` after its auto-restart).

### Files changed

- `apps/admin-console/src/shared/data/grid-persistence.ts` + `__tests__/grid-persistence.test.ts` (5 new tests)
- `apps/admin-console/src/shared/api/query-retry.ts` (new) + `__tests__/query-retry.test.ts` (new, 10 tests) + `index.ts`
- `apps/admin-console/src/shared/providers.tsx`
- `apps/admin-console/src/shared/layout/session-banners.tsx`
- `apps/admin-console/src/features/auth/components/login-form.tsx`
- `apps/admin-console/src/features/tenants/api/__tests__/tenants-hooks.test.tsx` (1 new test)
- 15 × `src/features/*/api/hooks.ts` (keepPreviousData; users also gets the cache invalidation)
- `apps/admin-console/next.config.ts`
- `docs/development-patterns-and-standards.md` §3.6 (adapter sentence updated)

### Verification evidence (2026-07-06)

- `pnpm --filter @arcaai/admin-console test` → **Test Files 80 passed (80), Tests 568 passed (568)** (was 552 before the ticket; +16 new)
- `pnpm --filter @arcaai/admin-console lint` → clean (`--max-warnings 0`)
- `pnpm --filter @arcaai/admin-console build` → succeeds with the experiment enabled (all routes compile)
- Dev server auto-restarted on the config change and lists `optimizePackageImports` under Experiments (terminal log)

### Follow-ups (out of scope)

- Bump `useSession`/`usePermissions` staleTime (60 s → 5 min) once product confirms permission-change latency is acceptable.
- Gateway `?namespace=` filter on `GET /user/me/settings` if settings rows grow.
- `@next/bundle-analyzer` pass; add `next/dynamic` only if a real heavy chunk shows up.

## Change History

- 2026-07-06 — Ticket opened; root cause + review approved in chat; implementation started.
- 2026-07-06 — All four changes implemented TDD; identity-change cache invalidation added (impersonation/login); full suite + lint + build green. Status → Review.
