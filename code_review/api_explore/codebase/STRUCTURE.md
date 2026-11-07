# Structure

## Top-level layout (apps/api)
| Path | Purpose | Evidence |
|---|---|---|
| `src/main.ts` | Bootstrap, audits, global prefix, pipes, interceptors (ETag), session, security headers, listen. | [apps/api/src/main.ts:50-499](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L50-L499) |
| `src/app.module.ts` | Root module: imports common + 79 modules, providers for interceptors/guards/filters. | [apps/api/src/app.module.ts:617-620](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L617-L620) |
| `src/modules/` | 79 directories; 148 controllers, 818 routes total. | [inventory/summary.json](./inventory/summary.json), [inventory/modules.json](./inventory/modules.json) |
| `src/bootstrap/` | Boot-time audit functions (permissions, API-key/service-account scope, consent, OCC, CASL reachability, WS ownership). | [apps/api/src/main.ts:8-17,365-460](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L8-L17), [apps/api/src/bootstrap/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/) |
| `src/guards/` | `JwtAuthGuard`, `OriginTenantBindingGuard`, `PatientConsentGuard`, `TenantLockGuard`, `RequiresIfMatchGuard`, `TenantOwnedResourceSseGuard`. | [apps/api/src/guards/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/), [apps/api/src/app.module.ts:209-267](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L209-L267) |
| `src/interceptors/` | `MetricsInterceptor`, `RateLimitHeadersInterceptor`, `ContextInterceptor`, `ExceptionInterceptor`, `MaintenanceInterceptor`, `ImpersonationAuditInterceptor`, `ETagInterceptor` (global). | [apps/api/src/app.module.ts:160-183](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L160-L183), [apps/api/src/main.ts:222-251](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L222-L251) |
| `src/filters/` | Exception filters in load-bearing order; unified error envelope. | [apps/api/src/app.module.ts:276-300](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L276-L300), [apps/api/src/filters/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/) |
| `src/decorators/` | `@RequiresIfMatch`, `@ExpectedVersion`, `@ApiEndpoint`, `@ApiDeprecated`, etc. | [apps/api/src/decorators/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/decorators/) |
| `src/config/` | `env.schema.ts`, `env.descriptors.ts`, `apiEnv()`. | [apps/api/src/config/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/), [apps/api/src/main.ts:64](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L64) |
| `src/shared/` | `base-proxy.controller.ts` (unused), `tenant-scope.ts`, `table-export.ts`. | [apps/api/src/shared/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/shared/) |
| `src/common/` | Tenant-owned resource SSE support. | [apps/api/src/common/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/) |
| `src/services/` | `graceful-shutdown.*`, `service-release-registration`. | [apps/api/src/services/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/services/) |
| `src/workers/` | BullMQ processors (e.g., scheduled rotation). | [apps/api/src/workers/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/workers/) |
| `src/observability/` | Metrics wiring. | [apps/api/src/observability/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/observability/) |
| `tests/` | Unit/integration/e2e (Vitest + Playwright). | [apps/api/tests/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/), [apps/api/package.json:66-70] |
| `test/` | Legacy Jest scaffold (unused). | [apps/api/test/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/test/), [apps/api/README.md:251] |
| `route-manifest.json` | Authorization oracle (818 routes). | [apps/api/route-manifest.json](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json), [inventory/routes.json](./inventory/routes.json) |
| `openapi.json` | Generated OpenAPI (607 paths). | [apps/api/openapi.json](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/openapi.json) |

## Modules with most routes (top)
| Module | Routes | Controllers | Evidence |
|---|---|---|---|
| `consultation` | ~89 | 3 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `harness-admin` | 29 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `workflow-definition` | 22 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `user` | ~21 | 3 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `agent-admin` | 20 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `streaming` | ~19 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `ai-model` | 17 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |
| `prompt-management` | 17 | 1 | [inventory/routes-by-module.md](./inventory/routes-by-module.md) |

## Controller inventory (excerpts)
- Controllers with **no test references** (any unit/e2e): `MyTenantDocumentTemplateController`, `StorageAccessKeyController`, `WorkflowInvariantRuleController`. [inventory/summary.json:28-32](./inventory/summary.json#L28-L32)
- Controllers with **no e2e route references**: 463 routes (many may have unit tests). [inventory/summary.json:23](./inventory/summary.json#L23)
- Controllers with **no unit test files referencing them**: see [inventory/controllers.json](./inventory/controllers.json).

## Evidence files
- Routes CSV: [inventory/routes.csv](./inventory/routes.csv)
- Routes JSON: [inventory/routes.json](./inventory/routes.json)
- Controllers map: [inventory/controllers.json](./inventory/controllers.json)
- Modules map: [inventory/modules.json](./inventory/modules.json)
- Source map builder: [tools/build_sourcemap.py](./tools/build_sourcemap.py)