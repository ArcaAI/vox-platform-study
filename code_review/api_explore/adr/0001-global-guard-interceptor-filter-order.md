# ADR-0001: Global guard/interceptor/filter order

**Status:** Accepted  
**Date:** 2026-10-23  
**Deciders:** API team  
**Context:** [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts), [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts), [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md)

## Decision

The API uses an explicit, ordered global pipeline:
- **Guards (APP_GUARD):** `TieredThrottlerGuard` → `ClsGuard` → `UnifiedAuthGuard` → `TenantLockGuard` → `PatientConsentGuard` → `TenantOwnedResourceSSEGuard` → `OriginTenantBindingGuard` → `RequiresIfMatchGuard`
- **Interceptors (APP_INTERCEPTOR):** `MetricsInterceptor` → `RateLimitHeadersInterceptor` → `ContextInterceptor` → `ExceptionInterceptor` → `MaintenanceInterceptor` → `ImpersonationAuditInterceptor` → `ETagInterceptor` (registered in [main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts))
- **Filters (APP_FILTER):** `AllExceptionsFilter`, `HttpExceptionEnvelopeFilter`, `DataNotFoundExceptionFilter`, `ConsentExceptionFilter` (last-registered wins per Nest)

## Rationale

- Throttling and context initialization happen before auth/authorization.
- Deny-by-default auth and tenancy/consent checks occur before business logic.
- Interceptors observe the request after routing/guards; metrics must see guard failures (noted in comments in [main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)).
- ETag/OCC are integrated with interceptors/guards.
- Exception filters normalize errors consistently at the edge.

## Consequences

- Order is load-bearing; changes require review and boot-time/regression testing.
- Comments in [app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) document dependencies (e.g. throttler needs API key service).
- Boot audits and tests help catch misconfigurations.

## References

- [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md)
- [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html)
- [docs/08-CODE-REVIEW.md](../docs/08-CODE-REVIEW.md)
