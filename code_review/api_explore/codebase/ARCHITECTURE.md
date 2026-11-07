# Architecture

## Overview
The API gateway is a NestJS 11 application that terminates HTTP/WebSocket traffic on port 8868 under prefix `api/v1`, enforces authentication/authorization/tenancy/consent, runs boot-time audits, and proxies/health-monitors downstream Python services. Business logic lives in `@arcaai/applications` and `@arcaai/domains`; the gateway holds no Prisma access and no domain rules of its own. [apps/api/README.md:7-13]

## Bootstrap sequence (main.ts)
1. **Crash handlers** installed first. [apps/api/src/main.ts:42-47]
2. **`loadEnv()`** loads/validates environment. [apps/api/src/main.ts:54,64]
3. **Secrets warmup**, OTel init, etc. before `NestFactory.create()`. [apps/api/src/main.ts:68-115]
4. **Create app** with `NestFactory.create(AppModule, { cors: ... })`. [apps/api/src/main.ts:116-151]
5. **Body limits**, WS adapter (`WsAdapter`), global prefix (`api/v1`). [apps/api/src/main.ts:149-158]
6. **Session middleware**, security headers/Helmet. [apps/api/src/main.ts:168-206]
7. **Validation pipe**, global interceptors (including `ETagInterceptor`), shutdown hooks. [apps/api/src/main.ts:206-256]
8. **Audits** (route permissions, API-key/service-account scopes, consent, OCC, WS ownership, CASL reachability). [apps/api/src/main.ts:330-460]
9. **Listen** on configured port. [apps/api/src/main.ts:484-499]

## Guard pipeline (AppModule, order load-bearing)
| Order | Guard | Purpose | Evidence |
|---|---|---|---|
| 1 | `TieredThrottlerGuard` | Rate limiting before auth; only `default` tier gates all routes. | [apps/api/src/app.module.ts:203-209](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L203-L209), [apps/api/README.md:191-192] |
| 2 | `ClsGuard` | Establishes CLS context. | [apps/api/src/app.module.ts:212-213](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L212-L213) |
| 3 | `UnifiedAuthGuard` | Deny-by-default JWT/API-key/service-account auth; `@Public()` is only opt-out. | [apps/api/src/app.module.ts:216-217](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L216-L217), [packages/applications/src/authorization/unified-auth.guard.ts:377-620](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L377-L620) |
| 4 | `TenantLockGuard` | 423 `TENANT_RESTORE_IN_PROGRESS` while restore holds lock (exempt via decorator). | [apps/api/src/app.module.ts:226-239](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L226-L239), [apps/api/src/guards/tenant-lock.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/tenant-lock.guard.ts) |
| 5 | `PatientConsentGuard` | Consent/ABAC; unconditional, no kill-switch; runs after auth, before OCC. | [apps/api/src/app.module.ts:239-248](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L239-L248), [apps/api/src/guards/patient-consent.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/patient-consent.guard.ts) |
| 6 | `TenantOwnedResourceSseGuard` | Pre-stream tenant assertion for `@Sse()` routes (404-before-stream). | [apps/api/src/app.module.ts:248-262](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L248-L262), [apps/api/src/common/tenant-owned-resource-sse.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/tenant-owned-resource-sse.guard.ts) |
| 7 | `OriginTenantBindingGuard` | Browser origin → registered tenant binding; after auth for CLS tenant. | [apps/api/src/app.module.ts:262-266](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L262-L266), [apps/api/src/guards/origin-tenant-binding.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/origin-tenant-binding.guard.ts) |
| 8 | `RequiresIfMatchGuard` | Propagates `@RequiresIfMatch()` marker for OCC param decorator. | [apps/api/src/app.module.ts:266-267](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L266-L267), [apps/api/src/decorators/requiresIfMatch.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/decorators/requiresIfMatch.guard.ts) |

## Interceptor pipeline
`MetricsInterceptor` → `RateLimitHeadersInterceptor` → `ContextInterceptor` → `ExceptionInterceptor` → `MaintenanceInterceptor` → `ImpersonationAuditInterceptor`, plus `ETagInterceptor` registered globally from `main.ts`. [apps/api/src/app.module.ts:159-183](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L159-L183), [apps/api/README.md:194-196]

## Exception filters (last-registered wins)
1. `AllExceptionsFilter` (`@Catch()`) — fallback 500 `INTERNAL.UNEXPECTED`.  
2. `HttpExceptionEnvelopeFilter` (`@Catch(HttpException)`) — normalizes HTTP exceptions.  
3. `DataNotFoundExceptionFilter` — 404 withholding details.  
4. `ConsentExceptionFilter` — consent verdicts.  
[apps/api/src/app.module.ts:276-300](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L276-L300), [apps/api/README.md:195-196]

## Authentication model (UnifiedAuthGuard)
- **Public opt-out:** `@Public()` / `SKIP_AUTH_KEY`. [packages/applications/src/authorization/unified-auth.guard.ts:434-448](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L434-L448)
- **Credential classes:** API key (headers `apikey`/`api-key`/`x-api-key`), JWT (Bearer), service account token (separate header/branch). **Ambiguous credentials rejected.** [packages/applications/src/authorization/unified-auth.guard.ts:458-600](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L458-L600)
- **API keys:** require explicit `@RequiredScopes(...)` (deny by default), checked against key scopes AND key's bound principal CASL abilities (conjunctive). [packages/applications/src/authorization/unified-auth.guard.ts:331-377](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L331-L377)
- **Service accounts:** separate principal/CLS key `serviceAccount`, `svc:*` scopes, CASL against account itself. [packages/applications/src/authorization/unified-auth.guard.ts:620-760](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L620-L760)
- **Stream tickets:** `?ticket=` handled by `JwtAuthGuard` (single-use, 30s TTL, Redis). [apps/api/src/guards/jwtauth.guard.ts:43-200](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/jwtauth.guard.ts#L43-L200), [apps/api/src/modules/auth/stream-ticket.service.ts:70-110](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/auth/stream-ticket.service.ts#L70-L110)

## Authorization
- Decorators from `@arcaai/applications`: `@Public`, `@Authorize`, `@AuthorizeAny`, `@CanRead/CanCreate/CanUpdate/CanDelete/CanManage`, etc. Class-level `@CanManage` gates admin controllers. [apps/api/README.md:230-240]
- **404-over-403** for cross-tenant access (with documented exceptions). [apps/api/README.md:239]
- **OCC:** `ETagInterceptor` makes `_version` a strong ETag; `@RequiresIfMatch()` + `@ExpectedVersion()` enforce If-Match; `OptimisticConcurrencyException` → 412. [apps/api/README.md:227-229], [apps/api/src/main.ts:222-251](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L222-L251)

## Boot-time audits (fail closed)
| Audit | Refuses on | Evidence |
|---|---|---|
| `auditAdminRoutePermissions` | Routes without `@Public()` or permission decorators. | [apps/api/src/main.ts:365-368](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L365-L368), [apps/api/src/bootstrap/admin-route-permission-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/admin-route-permission-audit.ts) |
| `auditApiKeyRequiredScopes` / `auditEveryApiKeyReachableRouteDeclaresScopes` | API-key-reachable routes without `@RequiredScopes()`. | [apps/api/src/main.ts:371-400](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L371-L400), [apps/api/src/bootstrap/api-key-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-scope-audit.ts) |
| `auditInternalRoutesOffApiKeySurface` | `/internal/*` on API-key surface. | [apps/api/src/main.ts:378-380](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L378-L380) |
| `auditAdminControllersDeclareNoApiKeyScopes` / `auditAdminScopedControllers` | Admin controllers with API-key scopes. | [apps/api/src/main.ts:383-394](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L383-L394) |
| `auditConsentRouteCoverage` | Routes needing consent decorators (coverage). | [apps/api/src/main.ts:412-412](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L412-L412), [apps/api/src/bootstrap/consent-route-coverage-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/consent-route-coverage-audit.ts) |
| `auditServiceAccountSurface` | Service-account surface leaking between classes. | [apps/api/src/main.ts:434-436](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L434-L436) |
| `auditWebSocketGatewayOwnerBinding` | Unclassified WS gateways. | [apps/api/src/main.ts:443-445](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L443-L445) |
| `auditCaslEnforcePairReachability` | CASL-enforced pairs that cannot produce denial. | [apps/api/src/main.ts:454-456](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L454-L456) |
| `auditOptimisticConcurrencyCoverage` | **Warn-only**: versioned routes missing `If-Match`. | [apps/api/src/main.ts:460-460](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L460-L460), [apps/api/README.md:222] |

## Downstream integrations
- **Proxied by gateway:** STT (REST + WS `/ws/stt/stream`), Text (`/api/v1/text-generations` etc., redirect shim for `/text`). [apps/api/README.md:243-246]
  - [apps/api/src/modules/streaming/stt-ws.gateway.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts)
  - [apps/api/src/modules/streaming/text-proxy.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/text-proxy.controller.ts)
  - [apps/api/src/modules/speech/speech-proxy.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/speech-proxy.controller.ts)
- **Health-monitored / reached elsewhere:** NLP, Guardrail, Harness, TTS — no gateway proxy route for most. `src/shared/base-proxy.controller.ts` is unused. [apps/api/README.md:245-246]
- **Internal service-to-service:** `/internal/*` routes, `InternalServiceTokenGuard`, service-account auth. [apps/api/src/modules/internal/internal.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/internal.module.ts), [apps/api/src/modules/internal/internal-service-token.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/internal-service-token.guard.ts)

## Tenant isolation
- **CLS tenant context** via `ClsService`, populated by auth; tenant scope enforced by Prisma extension via `TenantContextProvider`. [apps/api/src/database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts)
  - [packages/database/src/extensions/tenant-scope.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/database/src/extensions/tenant-scope.ts)
  - [apps/api/src/shared/tenant-scope.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/shared/tenant-scope.ts)
- **Origin binding** enforces browser-origin → tenant. [apps/api/src/guards/origin-tenant-binding.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/origin-tenant-binding.guard.ts)
- **Tenant lock** blocks requests during restore. [apps/api/src/guards/tenant-lock.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/tenant-lock.guard.ts)
- **Tenant-owned resources** with 404-over-403 and SSE-specific guard. [apps/api/src/common/tenant-owned-resource-sse.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/tenant-owned-resource-sse.guard.ts)

## Data / queues
- **Queues:** `JobQueue` enum (AuditLog, SpeechToText, consultations, DNA, Knowledge, SyncTenantDirectoryUsers, MineGateEditExemplar, AiUsageOutboxDrain, DownloadAiModel, WebhookDelivery, TenantCheckpointExport/Restore, ExtractFactLedger). [packages/domains/src/enums/JobQueue.enum.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/domains/src/enums/JobQueue.enum.ts)
- **Workers:** BullMQ processors registered via modules; checkpoint workers run in separate processes. [apps/api/src/app.module.ts:293](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L293), [apps/api/README.md:45-47]

## Evidence
- Root module: [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)
- Main: [apps/api/src/main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)
- UnifiedAuthGuard: [packages/applications/src/authorization/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts)
- Route manifest: [apps/api/route-manifest.json](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json)
- API README: [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)