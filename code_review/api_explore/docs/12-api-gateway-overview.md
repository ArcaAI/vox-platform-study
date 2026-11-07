# 12. API Gateway Overview

**Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
**App:** [`apps/api`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api) (`@arcaai/api`, NestJS 11)  
**Global prefix:** `api/v1` (see [`apps/api/src/global-prefix.config.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/global-prefix.config.ts))  
**Port:** 8868 (see [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md))  
**Generated from:** `apps/api/route-manifest.json`, `apps/api/openapi.json`, source code under `apps/api/src` and `packages/applications/src`

## What the API Gateway Does

The API gateway is the single entry point for all clients (web, mobile, API-key integrators, service accounts). It:

- **Terminates traffic**: HTTP and WebSocket traffic on port 8868 under `api/v1`. See [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts).
- **Enforces auth, tenancy, and consent**: Global guard/interceptor/filter pipeline (see below). Business logic lives in [`packages/applications`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications) and [`packages/domains`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/domains); `apps/api` holds no Prisma access and no domain rules of its own (see [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)).
- **Routes/orchestrates requests**: NestJS controllers in [`apps/api/src/modules/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules) call services in `packages/applications`. Some routes **proxy** to downstream Python services; most routes are in-process (DB via services) with external calls made by service-layer clients.
- **Applies boot-time safety audits**: `main.ts` runs audits that refuse to start on authorization drift (route permissions, API-key scope coverage, internal routes off API-key surface, admin scope rules, consent coverage, OCC coverage, CASL-enforce reachability, WS gateway ownership). See [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) and [`apps/api/src/bootstrap/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap).

## Planes (Business vs Administration)

Per [`apps/api/openapi.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/openapi.json):

- **Business plane** — tenant-facing routes. Reachable with a user JWT, a tenant **API key**, or a service-account token.
- **Administration plane** (`/api/v1/admin/**`) — reachable with a user JWT or a **service-account token** only. Every route carries `@ForbidApiKey()`, enforced before scope/ability checks.

Scopes bind the credential; abilities bind the human the credential acts for. They compose as AND. Cross-tenant access is 404, never 403 (404-over-403).

## Request Pipeline (Guard/Interceptor/Filter Order)

From [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) and [`apps/api/src/app.module.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts):

**Guards (declaration order, load-bearing):**
1. `TieredThrottlerGuard` — runs before auth
2. `ClsGuard` — establishes CLS context
3. `UnifiedAuthGuard` — deny-by-default JWT/API-key/service-account auth. `@Public()` is the only opt-out
4. `PatientConsentGuard` — consent/ABAC, must run after auth and before OCC
5. `TenantOwnedResourceSseGuard` — pre-stream tenant assertion for `@Sse()` routes
6. `OriginTenantBindingGuard` — binds browser Origin to registered tenant
7. `RequiresIfMatchGuard` — propagates `@RequiresIfMatch()` for OCC

**Interceptors:** `MetricsInterceptor`, `RateLimitHeadersInterceptor`, `ContextInterceptor`, `ExceptionInterceptor`, `MaintenanceInterceptor`, `ImpersonationAuditInterceptor`, plus globally-registered `ETagInterceptor` (from [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts)).

**Filters:** `HttpExceptionEnvelopeFilter` (catch-all, registered first), `DataNotFoundExceptionFilter`, `ConsentExceptionFilter`.

**Optimistic Concurrency:** `_version` becomes strong `ETag` via `ETagInterceptor`; client resends as `If-Match`; `@RequiresIfMatch()` + `@ExpectedVersion()` feed `repository.updateWithVersion(...)`; drift throws `OptimisticConcurrencyException` → 412.

## Proxying vs Orchestration

From [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md):

- **Proxied by gateway (HTTP/WebSocket routes):** STT (streaming audio via [`SttWsGateway`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts) on `/ws/stt/stream`, plus REST under `audio/transcription-jobs`) and Text ([`TextProxyController`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/text-proxy.controller.ts) under `text-generations`, plus redirect shim). TTS also has REST proxy ([`SpeechProxyController`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/speech-proxy.controller.ts)) and WS bridge ([`TtsWsGateway`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/tts-ws.gateway.ts)).
- **Not proxied by gateway routes:** NLP, Guardrail, and Harness are reached by other Python services directly or are health-monitored only — they have no gateway proxy route. [`apps/api/src/shared/base-proxy.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/shared/base-proxy.controller.ts) is abstract and has zero production subclasses (dead code).
- **Orchestration:** Most business/admin routes call services in `packages/applications` which make HTTP calls to downstream services (Text/NLP/Guardrail/HarneSS/TTS/STT), call external providers (OpenID/Google/MS Graph), use object storage (S3/MinIO), queues (BullMQ/Redis), etc.

## Route Inventory (Source of Truth)

From [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json) and [`../review/api_explore/inventory/summary.json`](../inventory/summary.json):

| Metric | Value |
|---|---|
| Total routes | 818 |
| Controllers | 148 |
| Modules | 77 |
| OpenAPI paths | 607 |
| Public routes | 62 |
| API-key forbidden | 573 |
| API-key allowed | 189 |
| Requires If-Match (OCC) | 69 |
| API-excluded | 57 |
| Routes with no permission/scope | 78 |

**Methods:** GET 404, POST 267, PATCH 63, PUT 31, DELETE 53.

## Key Artifacts

| Artifact | Purpose | Location |
|---|---|---|
| Route manifest | Authorization oracle (per-route auth, scopes, OCC, etc.) | [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json) |
| OpenAPI | Request/response schema + tags/operations | [`apps/api/openapi.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/openapi.json) |
| Route inventory (explore) | Full inventory with tests/coverage | [`inventory/routes.json`](../inventory/routes.json), [`inventory/routes-by-module.md`](../inventory/routes-by-module.md) |
| Architecture docs | Guard pipeline, modules | [`codebase/ARCHITECTURE.md`](../codebase/ARCHITECTURE.md) |
| Diagrams | Visual maps | [`diagrams/api-gateway-internals-deep-dive.html`](../diagrams/api-gateway-internals-deep-dive.html) |
