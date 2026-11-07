# Error Code Taxonomy & Diagnostic Dictionary

This document provides a comprehensive troubleshooting reference for all error codes, exception classes, and HTTP status codes emitted by the HOPE API Gateway ([`apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)).

---

## 1. The Unified Error Envelope

Every error leaving the gateway is intercepted by [`HttpExceptionEnvelopeFilter`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/filters/http-exception-envelope.filter.ts) and conforms to this standardized structure:

```json
{
  "statusCode": 403,
  "code": "DOMAIN.CONSENT_DENIED",
  "message": "Patient consent has not been granted for this consultation",
  "correlationId": "corr-8f3a9e12-4c21-482a-a921-ef0218764a88",
  "details": {
    "patientId": "pat-10492",
    "requiredScope": "CONSENT_SOAP_NOTES"
  },
  "timestamp": "2026-10-23T14:22:10.512Z"
}
```

### Key Fields for Troubleshooting:
- `code`: The stable machine-readable error string (never changes across software releases).
- `correlationId`: Unique request ID attached in NestJS AsyncLocalStorage (`ClsService`). **Use this ID to search production logs** across both the gateway and downstream Python services.
- `statusCode`: Standard HTTP response code.
- `message`: Human-readable explanation of why the request failed.

---

## 2. Comprehensive Error Code Catalog

### A. Authentication, Authorization & Tenancy (401 / 403 / 404)

| HTTP Status | Error Code (`code`) | Originating Layer | Root Cause | How to Troubleshoot / Fix |
|---|---|---|---|---|
| **401** | `HTTP.UNAUTHORIZED` | `UnifiedAuthGuard` | Missing, expired, or malformed JWT Bearer token / API key. | Inspect `Authorization` header. Check token expiration date or verify signing key in Vault (`JWT_SECRET_KEY`). |
| **403** | `HTTP.FORBIDDEN` | `UnifiedAuthGuard` | User lacks required CASL ability (e.g. `@CanManage('Department')`). | Compare user's role in DB `UserRole` table against required permission listed in [`route-manifest.json`](file:///Users/apple/repos/VOX/project-hope/apps/api/route-manifest.json). |
| **403** | `API_KEY_FORBIDDEN` | `UnifiedAuthGuard` | Client attempted to access an admin route using an API Key. | Admin routes carry `@ForbidApiKey()`. Admin operations require an interactive user JWT Bearer token. |
| **403** | `API_KEY_SCOPE_MISMATCH`| `UnifiedAuthGuard` | API key lacks required scope (e.g. missing `consultation:session:write`). | Query `ApiKey` table in PostgreSQL; regenerate key with needed scopes from [`ApiKeyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/api-key/api-key.controller.ts). |
| **403** | `DOMAIN.CONSENT_DENIED` | `PatientConsentGuard` | Active patient consent record does not exist for the patient referenced by `:patientId`. | Unconditional compliance check. Verify consent grant exists in `PatientConsent` table or verify consultation `patientId`. |
| **404** | `PERSISTENCE.DATA_NOT_FOUND`| Repository / Gateway | **Either** the entity does not exist, **OR** the entity belongs to another tenant (404-over-403 defense). | Check database with tenant filter removed to determine if this is a cross-tenant attempt or true non-existence. |
| **503** | `DOMAIN.CONSENT_UNAVAILABLE`| `PatientConsentGuard` | Consent verification store / Redis lookup timed out or failed. | Fail-closed security rule. Check Redis connection pool and consent cache service health. |

---

### B. Optimistic Concurrency Control (OCC) (412 / 428)

The gateway uses Optimistic Concurrency Control on versioned resources (`Consultation`, `AgentAssignment`, `TenantBucket`, etc.) to prevent lost updates:

| HTTP Status | Error Code (`code`) | Originating Layer | Root Cause | How to Troubleshoot / Fix |
|---|---|---|---|---|
| **428** | `HTTP.PRECONDITION_REQUIRED` | `RequiresIfMatchGuard` | Client performed `PUT`/`PATCH`/`DELETE` on a versioned route without supplying an `If-Match` header. | Client must first `GET` the resource, read the `ETag` response header, and include `If-Match: "<version>"` in the update request. |
| **412** | `PERSISTENCE.CONCURRENCY_CONFLICT` | `ExpectedVersion` / Repository | The entity was updated by another user between the client's `GET` and `PATCH` requests (`If-Match` mismatch). | Client must fetch the latest version of the resource, merge changes, and retry with the updated version tag. |

---

### C. Validation & Payload Errors (400 / 422)

| HTTP Status | Error Code (`code`) | Originating Layer | Root Cause | How to Troubleshoot / Fix |
|---|---|---|---|---|
| **400** | `VALIDATION.FAILED` | Global `ValidationPipe` | Request body failed class-validator rules (missing required fields, unexpected properties, invalid types). | Inspect response `details` or `subErrors` array. Gateway uses `forbidNonWhitelisted: true`, so unknown fields are rejected. |
| **400** | `GENERIC.ARGUMENT_INVALID`| Application Service | Business constraint violated (e.g., date range inverted, invalid enum transition). | Check application service validation in `packages/applications`. |
| **422** | `HTTP.UNPROCESSABLE_ENTITY`| `TextProxyController` | Prompt failed downstream Guardrail safety checks (prompt injection, toxic content, or unmasked PHI). | Review input text against active tenant guardrail policy in [`GuardrailPolicyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-policy/guardrail-policy.controller.ts). |

---

### D. Rate Limiting, Quotas & Spend Limits (402 / 409 / 429)

| HTTP Status | Error Code (`code`) | Originating Layer | Root Cause | How to Troubleshoot / Fix |
|---|---|---|---|---|
| **429** | `HTTP.TOO_MANY_REQUESTS` | `TieredThrottlerGuard` | Client exceeded rate limits (default: 100 req/min; strict: 10 req/min for `/auth/login`). | Check Redis rate limiter keys (`throttle:*`). Inspect `Retry-After` header. Adjust limits in `RateLimitAdminController`. |
| **409** | `DOMAIN.QUOTA_EXCEEDED` | `EntitlementsService` | Tenant monthly consultation or token quota exhausted. | Review tenant subscription tier and quota allowances in `TenantPlanController`. |
| **402** | `DOMAIN.SPEND_LIMIT_EXCEEDED`| `BillingService` | Tenant hard spending cap exceeded on LLM / GPU compute tokens. | Check billing ledger in `BillingController`. An admin must increase the tenant compute budget limit. |

---

## 3. The "404 vs 403" Gotcha (Cross-Tenant Defense)

### The Security Invariant:
To prevent attackers from enumerating valid resource IDs belonging to other hospitals/clinics, the gateway enforces **404-over-403**:
```
User (Tenant A) requests: GET /api/v1/consultations/c-tenant-b-999
Result: 404 NOT FOUND (NOT 403 FORBIDDEN)
```

### How a Developer Diagnoses This:
1. Copy the `correlationId` from the error response.
2. Search the server logs:
   ```bash
   grep "<correlationId>" /var/log/hope/api.log
   ```
3. Look for the log line emitted by `tenant-context.provider.ts`:
   ```text
   WARN [TenantContext] Cross-tenant access attempted: callerTenant=tenant-alpha requestedEntityTenant=tenant-beta entity=Consultation id=c-999
   ```
4. If you see this warning, the resource **exists in the database**, but the user is logged into the wrong tenant.

---

## 4. Boot-Time Audit Failures (Startup Crashes)

If `apps/api` crashes during startup (`NestFactory.create` finishes but process terminates with code 1), one of the fail-fast startup audits failed:

| Audit Name | Startup Error Message | Resolution |
|---|---|---|
| `auditAdminRoutePermissions` | `Route [GET /api/v1/...] missing authorization decorator` | Add `@CanRead(...)`, `@CanManage(...)`, or `@Public()` to the controller handler. |
| `auditApiKeyRequiredScopes` | `API-key reachable route [...] missing @RequiredScopes` | Add `@RequiredScopes('scope:name')` or mark controller with `@ForbidApiKey()`. |
| `auditConsentRouteCoverage` | `Route with :patientId [...] missing @RequiresConsent` | Add `@RequiresConsent()` or `@ConsentExempt()` to the handler. |
| `auditAdminControllersDeclareNoApiKeyScopes` | `Admin controller [...] must not declare API key scopes` | Remove API key scopes from `/admin/*` routes; admin surface is JWT-only. |
| `assertJwtSecretNotPlaceholder` | `JWT_SECRET_KEY is using insecure placeholder value` | Provide a valid production secret or configure Vault connection. |
| `assertGenaiContentCaptureDisabled`| `OTel GenAI content capture must be false in prod` | Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=false` (PHI privacy compliance). |
