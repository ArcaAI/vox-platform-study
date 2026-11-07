# Incident Troubleshooting Runbooks & Decision Trees

This document provides step-by-step diagnostic workflows for the most frequent issues encountered when developing against or running the HOPE API Gateway ([`apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)).

---

## Runbook 1: Diagnosing 401 Unauthorized / 403 Forbidden

```mermaid
graph TD
    A[Client Receives 401 or 403] --> B{Status Code?}
    B -->|401 Unauthorized| C[Check Authorization Header]
    B -->|403 Forbidden| D[Check Credential Class Used]
    
    C --> C1{Bearer Token Present?}
    C1 -->|No| C2[Client omitted Authorization header or stream ticket]
    C1 -->|Yes| C3{Token Expired or Invalid Signature?}
    C3 -->|Yes| C4[Re-authenticate or check Vault JWT_SECRET_KEY rotation]
    C3 -->|No| C5[Check if user account was locked or revoked in User table]

    D --> D1{Credential Class?}
    D1 -->|API Key| D2{Is route in admin plane?}
    D2 -->|Yes| D3[BLOCKED: Admin routes carry @ForbidApiKey. Must use User JWT.]
    D2 -->|No| D4{Does API key have declared scopes?}
    D4 -->|No| D5[Update API key scopes via ApiKeyController]
    
    D1 -->|User JWT Bearer| D6{Does route reference :patientId?}
    D6 -->|Yes| D7{Active consent in PatientConsent table?}
    D7 -->|No| D8[BLOCKED by PatientConsentGuard: Patient consent missing]
    D6 -->|No| D9[Check CASL permissions in UserRole against @CanRead/@CanManage]
```

### Actionable Checkpoints:
1. **If using API Key:** Search [`route-manifest.json`](file:///Users/apple/repos/VOX/project-hope/apps/api/route-manifest.json) for your path. If `apiKeyForbidden: true`, this route cannot be reached by server-to-server API keys.
2. **If using JWT:** Decode your token (`jwt.io` or `jwt-cli`) and inspect:
   - `exp`: Is it in the past?
   - `tenantId`: Does it match the target resource's hospital/tenant?
   - `roles`: Does your role have permissions on the CASL subject?
3. **If 403 on Consultation Route:** Check if `:patientId` is present. If so, `PatientConsentGuard` ran and rejected the caller because the patient revoked or never granted consent.

---

## Runbook 2: Diagnosing 404 Not Found & Cross-Tenant Leaks

```text
Step 1: Check the URL prefix
  └── All business routes MUST be prefixed with `/api/v1/`
        ❌ Bad:  GET /consultations/123
        ✅ Good: GET /api/v1/consultations/123

Step 2: Check for 404-over-403 (Cross-Tenant Defense)
  └── Did the database record exist, but with a different tenantId?
        Run query: SELECT id, "tenantId" FROM "Consultation" WHERE id = 'c-123';
        • If tenantId matches caller JWT: Entity genuinely missing or soft-deleted.
        • If tenantId differs from caller JWT: Intentionally returned 404 to protect privacy.

Step 3: Check Subcollection Parent Binding
  └── Routes like `/api/v1/departments/:depId/rooms/:roomId`
        Verify that `roomId` actually belongs to `depId`. The gateway returns 404 if a room
        belongs to another department, even within the same hospital tenant.
```

---

## Runbook 3: Diagnosing 412 Concurrency Conflicts & 428 Preconditions

```text
Problem: PATCH /api/v1/consultations/:id returns 428 Precondition Required
  └── Cause: The route is marked with `@RequiresIfMatch()`.
  └── Solution:
        1. Perform a `GET /api/v1/consultations/:id` first.
        2. Read the `ETag` header from the response (e.g. `ETag: "14"`).
        3. Include `If-Match: "14"` in the headers of your PATCH request.

Problem: PATCH /api/v1/consultations/:id returns 412 Precondition Failed
  └── Cause: Race condition / concurrency conflict. Another user updated the record
      in the database and incremented `_version` from 14 to 15.
  └── Solution:
        1. Fetch the latest entity via GET.
        2. Merge your changes with the current state.
        3. Re-issue PATCH using the new `If-Match: "15"`.
```

---

## Runbook 4: Gateway Fails to Boot / Startup Crash

```mermaid
graph TD
    Boot[pnpm api:dev fails immediately with exit code 1] --> CheckLogs[Inspect startup log output]
    CheckLogs --> Branch{Failure Type?}
    
    Branch -->|Zod Validation Error| Zod[Missing or malformed environment variable. Check env.schema.ts against .env]
    Branch -->|Placeholder Secret| Secret[assertJwtSecretNotPlaceholder failed: JWT_SECRET_KEY is 'changeme' or default]
    Branch -->|Audit Failure| Audit[Fail-Fast Authorization Audit triggered in src/bootstrap]
    Branch -->|DB Connection Refused| DB[PostgreSQL or Prisma unavailable on localhost:5432]
```

### Fixing Common Boot Audit Failures:
1. **`auditAdminRoutePermissions` failed:**
   - A newly created controller method forgot authorization. Add `@CanRead('Resource')`, `@CanManage('Resource')`, or `@Public()` above the handler.
2. **`auditApiKeyRequiredScopes` failed:**
   - A non-public route is accessible to API keys but did not declare required scopes. Add `@RequiredScopes('scope:name')` or add `@ForbidApiKey()` to the controller class.
3. **`auditConsentRouteCoverage` failed:**
   - A route contains `:patientId` in its path parameter without declaring patient consent rules. Add `@RequiresConsent()` or `@ConsentExempt('reason')`.

---

## Runbook 5: WebSocket (`/ws/stt/stream`) Disconnecting

```text
Symptom: Client connects to ws://localhost:8868/ws/stt/stream?ticket=XYZ and drops immediately.

Check 1: Was the Stream Ticket Expired?
  • Stream tickets have a strict 30-second TTL in Redis.
  • Stream tickets are single-use (atomically deleted on first read).
  • Fix: Request a fresh ticket immediately before opening the WebSocket socket.

Check 2: Origin Tenant Binding (CORS for WebSockets)
  • OriginTenantBindingGuard checks if the browser's `Origin` header is registered in the
    `TenantAllowedOrigin` table for the caller's tenant.
  • Fix: Verify the client app's domain (e.g. `http://localhost:3000`) is registered via
    `TenantAllowedOriginController`.

Check 3: Downstream Python STT Service Health
  • Is the Python STT service running on port 8861?
  • Run: curl http://localhost:8861/health
  • If STT engine crashed (e.g. CUDA OOM), the gateway closes the socket with code 1011.
```

---

## Runbook 6: SOAP Note Generation Stuck in `pending`

```text
Symptom: POST /api/v1/consultations/:id/summary returns { status: "pending" }
         but consultation state never transitions to "GENERATED".

Check 1: Temporal Workflow Execution
  • Open Temporal Web UI: http://localhost:8233
  • Search for WorkflowId: `consultation-harness-${consultationId}`
  • Status options:
      - Running: Check which step is active (Guides, Generate, Sensors, or Gate).
      - TimedOut / Failed: Inspect activity failure stack trace.

Check 2: Python Text Microservice (Port 8862)
  • Is the LLM service answering requests?
  • Run: curl http://localhost:8862/health
  • Check server logs for LLM provider rate limits (e.g. Azure OpenAI 429 Too Many Requests).

Check 3: Harness Internal Callback Ingress
  • When Temporal finishes generation, it calls back into:
    `POST /api/v1/internal/harness/callback`
  • Verify that `X-Service-Token` is correctly configured between Temporal workers and gateway.
```
