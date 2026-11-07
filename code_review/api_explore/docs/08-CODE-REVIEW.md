# Code Review: apps/api

**Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
**Scope:** `apps/api/src` (NestJS gateway). Review focuses on architecture, security, maintainability, and testability.  
**Evidence:** [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md), [codebase/CONCERNS.md](../codebase/CONCERNS.md), [inventory/summary.json](../inventory/summary.json), [logs/vitest-coverage.log](../logs/vitest-coverage.log), [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md)

## Executive summary

- **Strengths:** Explicit global guard/interceptor/filter order with clear comments in [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts), deny-by-default auth via [packages/applications/src/authorization/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts), strong tenant isolation via CLS + [apps/api/src/database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts), and comprehensive boot-time audits in [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts).
- **Risks:** Low coverage in several areas (e.g. graceful shutdown, route catalog, workflow sandbox/invariants), 463/818 routes lack direct e2e route references, and three controllers have no test references.
- **Overall posture:** Security-conscious with defense-in-depth; test coverage is good overall (87.72% statements) but uneven in operational/admin and newer workflow features.

## Architecture and composition

| Area | Assessment | Notes/Evidence |
|---|---|---|
| Boot order | Good | Global prefix `/api/v1` in [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts); guards run before interceptors (see comments in main); `ETagInterceptor` registered in main. |
| DI composition | Good | [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) composes `common` + `featureModules` arrays, wires `APP_GUARD`/`APP_INTERCEPTOR`/`APP_FILTER` in explicit order. |
| Module organization | Good | Feature modules grouped by domain (clinical, agent/workflows, AI, tenancy, storage, ops). See [codebase/STRUCTURE.md](../codebase/STRUCTURE.md). |
| Boot-time validation | Excellent | Boot audits for permissions, API-key scopes, internal routes, admin scope declarations, business-plane exemptions, consent coverage, service-account surface, WS gateway owner binding, CASL reachability, OCC coverage. OCC is warn-only; others fail closed. |

## Security review

| Control | Assessment | Notes/Evidence |
|---|---|---|
| Authentication | Strong | [UnifiedAuthGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts) is deny-by-default; supports JWT, API keys, service accounts, stream tickets. Unknown credential classes fail closed. See [apps/api/src/app.module.ts:191-207](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts). |
| Authorization | Strong | [AuthorizationGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/authorization.guard.ts) uses CASL/RBAC abilities. Routes/controllers may declare permissions/scopes. |
| Tenant isolation | Strong | CLS request context ([apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts): `ClsGuard`), tenant-scoped Prisma via [apps/api/src/database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts), [OriginTenantBindingGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/origin-tenant-binding.guard.ts), [TenantOwnedResourceSSEGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/tenant-owned-resource-sse.guard.ts). 404-over-403 used to avoid leaking existence. |
| Consent/ABAC | Strong | [PatientConsentGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/patient-consent.guard.ts) + [ConsentExceptionFilter](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/consent.filter.ts). Consent route coverage audited at boot. |
| Rate limiting | Good | [TieredThrottlerGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/throttle/tiered-throttler.guard.ts) with Redis-backed storage; headers added by [RateLimitHeadersInterceptor](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/throttle/rate-limit-headers.interceptor.ts). |
| OCC/ETag | Good | [ETagInterceptor](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/etag.interceptor.ts) generates strong ETags; [RequiresIfMatchGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/decorators/requiresIfMatch.guard.ts) enforces preconditions. OCC coverage audited at boot (warn-only). |
| Error handling | Good | Filter chain normalizes errors; [HttpExceptionEnvelopeFilter](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/http-exception-envelope.filter.ts) provides consistent envelope. See [apps/api/src/filters/global-filters.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/global-filters.ts). |

## Code quality observations

| Observation | Severity | Recommendation | Evidence |
|---|---|---|---|
| Guard/interceptor/filter order is explicit but easy to misorder | Medium | Keep comments in [app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) and enforce via boot checks where possible. Consider a regression test. | Order documented in [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) |
| Large `AppModule` imports arrays | Low | Consider module aggregation or lazy loading where appropriate; arrays are readable and auditable as-is. | [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) |
| Three controllers have no test references | Medium | Add unit/e2e tests for `MyTenantDocumentTemplateController`, `StorageAccessKeyController`, `WorkflowInvariantRuleController`. | [inventory/summary.json](../inventory/summary.json), [codebase/CONCERNS.md](../codebase/CONCERNS.md) |
| Low coverage in operational paths | Medium | Improve coverage for graceful shutdown, route catalog, workflow sandbox/invariants. | [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md) |
| 463 routes without direct e2e route references | Medium | Prioritize e2e coverage for high-risk routes (admin, auth, consent, billing, webhooks). | [inventory/summary.json](../inventory/summary.json) |
| Boot audits are comprehensive but OCC warn-only | Low | Consider making OCC coverage fail-closed or add alerting; document rationale. | [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts) |

## Testing posture

- **Unit/Integration:** Vitest with 444 passed / 2 skipped test files, 5336 passed / 11 skipped tests, exit 0. Overall coverage: 87.72% statements, 78.04% branches, 86.12% functions (450 files). See [logs/vitest-coverage.log](../logs/vitest-coverage.log).
- **E2E:** 165 e2e specs (31 cross-tenant). See [codebase/TESTING.md](../codebase/TESTING.md).
- **Coverage report:** [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md) with lowest files and area summaries.

## Recommendations

1. **Add tests for untested controllers** - Highest immediate value given security/admin implications.
2. **Expand e2e coverage** - Focus on routes with no permission/scope (78) and routes without e2e references in critical areas.
3. **Raise coverage in operational modules** - Graceful shutdown and route catalog are often untested but important for reliability.
4. **Add regression tests for guard order** - Prevent accidental reordering of global providers.
5. **Document OCC warning rationale** - Make the warn-only decision explicit in ADR or code comments if not already.

## References

- [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md)
- [codebase/CONCERNS.md](../codebase/CONCERNS.md)
- [codebase/TESTING.md](../codebase/TESTING.md)
- [inventory/summary.json](../inventory/summary.json)
- [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html)
