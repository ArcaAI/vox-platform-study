# API Gateway B03a3 — Consultation Internal/Harness

Companion explainer for `api-gateway-b03a3-consultation-internal-harness.html`.

## Scope
`B03a3` (part of B03-consultation-core split): `harness-internal` (29+ route decorators observed), `consultation-read-internal`, `consent-internal`. Internal/service-to-service surfaces; excluded from public Swagger in controller metadata. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes | Controller | Service | Downstream |
|---|---|---|---|---|
| Harness config/creds | `/internal/harness` policy, prompt-templates resolved, models resolve, mcp-token, provider-credential (+ others; reconcile full list) | `HarnessInternalController` (`harness-internal.controller.ts:453`, guards at :452) | `HarnessInternalService` (`harness-internal.service.ts:269`) | Model/MCP/provider registries; config state |
| Harness consultation ops | `/internal/harness/consultations/:id` entities (POST/GET), assemble, draft, gate-decision, escalation (+ related ops) | `HarnessInternalController` (`:731+`) | `HarnessInternalService` | Consultation/entities/draft/gate state |
| Internal consultation read | `POST /internal/consultations/:consultationId/read` (declared `consultation.*` paths, node/run scoped) | `ConsultationReadInternalController` (`consultation-read-internal.controller.ts:48,55`) | `IConsultationReadService` (injected) | Consultation state; audited read (paths, not values) |
| Internal consent assert | `POST /internal/consent/assert` (non-throwing decision for non-HTTP callers) | `ConsentInternalController` (`consent-internal.controller.ts:93,101`) | `IConsultationConsentService` / `checkConsent` (injected) | Consent grants; tenant-scoped CLS context |

## Example input/output (representative)
- **Models resolve:** `GET /internal/harness/models/resolve` (taskKey/slug + tenant/taskType context) -> resolved model/provider metadata.
- **Consultation read:** body `{runId,nodeId,paths[]}` + `X-Tenant-Id` -> `{values, readAt, schemaVersion}`; validates declared paths/schema; 400 unknown/undeclared, 404 foreign/unknown run/consultation.
- **Consent assert:** `{tenantId, externalPatientId, purpose, scope?, consultationId?, toolName?}` -> `{allowed, reason?/unavailable?, grantId?, expiresAt?}` (distinguishes denial vs unavailable).
- **Harness ops:** entities/assemble/draft/gate-decision/escalation internal DTOs (+ idempotency where applicable) -> persisted operation results. Verify exact schemas.

## Security / validation / limitations
- **Internal only:** controllers use `@ApiExcludeController`/`@Public` with `HarnessServiceTokenGuard` (+ `InternalTenantLockGuard` where applied). `X-Service-Token` and tenant context requirements are evidenced in controller code.
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Limitations: grouped endpoint nodes (harness-internal is large; full route inventory must be reconciled with controller/OpenAPI/internal docs); downstream registry topology summarized; audit/PHI-safety behavior is implementation-specific (noted in code comments).
