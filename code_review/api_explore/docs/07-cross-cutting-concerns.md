# 07. Cross-Cutting Concerns

**Sources:** [`apps/api/src/filters/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/), [`apps/api/src/interceptors/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/), [`apps/api/src/decorators/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/decorators/), [`apps/api/src/common/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/)

## Filters
| Filter | Purpose |
| --- | --- |
| [`HttpExceptionEnvelopeFilter`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/http-exception-envelope.filter.ts) | Catch-all envelope filter (registered first) |
| [`DataNotFoundExceptionFilter`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/) | Data not found handling |
| [`ConsentExceptionFilter`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/) | Consent exception handling |
| [`downstream-error.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/downstream-error.ts) | Downstream error normalization, `redactTopology`, transport error classification |

See [23-error-handling-and-downstream-failures.md](23-error-handling-and-downstream-failures.md) for details.

## Interceptors
| Interceptor | Purpose |
| --- | --- |
| `MetricsInterceptor` | Metrics collection |
| `RateLimitHeadersInterceptor` | Rate limit headers |
| `ContextInterceptor` | Request context |
| `ExceptionInterceptor` | Exception transformation |
| `MaintenanceInterceptor` | Maintenance mode |
| `ImpersonationAuditInterceptor` | Impersonation auditing |
| `ETagInterceptor` (global) | ETag generation for OCC |

## Decorators
| Decorator | Purpose |
| --- | --- |
| `@RequiresIfMatch()` | Enforces If-Match header for OCC (428 if missing) |
| `@ExpectedVersion()` | Extract version from header/body for OCC |
| `@ApiEndpoint()` | API endpoint metadata |
| `@ApiDeprecated()` | Mark deprecated endpoints |
| `@Public()`, `@Authorize()`, `@Can*()`, `@RequiredScopes()`, `@ForbidApiKey()` | Authz decorators |

## Common Utilities
| Component | Purpose |
| --- | --- |
| [`TenantOwnedResourceSseGuard`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/) | Pre-stream tenant assertion for SSE routes |
| [`redirect-shim.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/redirect-shim.ts) | 308 redirects for retired business-plane URIs |
| [`request-id.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/request-id.ts) | Request ID handling |

## Optimistic Concurrency
See [04-request-lifecycle.md](04-request-lifecycle.md) for full OCC flow.
