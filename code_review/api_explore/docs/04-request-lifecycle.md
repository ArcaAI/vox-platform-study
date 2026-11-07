# 04. Request Lifecycle

**Sources:** [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md), [`apps/api/src/app.module.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts), [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)

## Bootstrap
1. Load env via `loadEnv()` / config
2. Create Nest app, set up `WsAdapter` for WebSockets
3. Apply global prefix (`api/v1`) with exclusions (see [`apps/api/src/global-prefix.config.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/global-prefix.config.ts))
4. Register global pipes/filters/interceptors/security headers/session
5. Run boot-time audits (fail-fast on drift)
6. Start server on port 8868

See [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts).

## Guard Pipeline (Declaration Order - Load Bearing)
From [`apps/api/src/app.module.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) and [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md):

| Order | Guard | Purpose |
| --- | --- | --- |
| 1 | `TieredThrottlerGuard` | Rate limiting before auth |
| 2 | `ClsGuard` | Establish CLS context |
| 3 | `UnifiedAuthGuard` | Deny-by-default auth (JWT/API key/service account). `@Public()` is only opt-out |
| 4 | `PatientConsentGuard` | Consent/ABAC (must run after auth, before OCC) |
| 5 | `TenantOwnedResourceSseGuard` | Pre-stream tenant assertion for `@Sse()` routes |
| 6 | `OriginTenantBindingGuard` | Bind browser Origin to registered tenant (needs CLS tenant) |
| 7 | `RequiresIfMatchGuard` | Propagate `@RequiresIfMatch()` for OCC |

## Interceptors (Order)
`MetricsInterceptor`, `RateLimitHeadersInterceptor`, `ContextInterceptor`, `ExceptionInterceptor`, `MaintenanceInterceptor`, `ImpersonationAuditInterceptor`, plus globally-registered `ETagInterceptor` from `main.ts`.

## Filters
`HttpExceptionEnvelopeFilter` (catch-all, registered first), `DataNotFoundExceptionFilter`, `ConsentExceptionFilter`.

## Optimistic Concurrency (OCC)
1. `_version` on entity becomes strong `ETag` via `ETagInterceptor`
2. Client resends as `If-Match`
3. `@RequiresIfMatch()` (missing header → 428) + `@ExpectedVersion()` feed `repository.updateWithVersion(...)`
4. Drift throws `OptimisticConcurrencyException` → 412

See [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md).
