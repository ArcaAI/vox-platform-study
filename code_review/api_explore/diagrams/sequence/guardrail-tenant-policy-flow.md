# Tenant Guardrail Policy Configuration Flow (`guardrail-tenant-policy-flow`)

> **Interactive Diagram:** [`guardrail-tenant-policy-flow.html`](guardrail-tenant-policy-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **guardrail-tenant-policy-flow** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/guardrail/policy`
- **Handler Method:** [`TenantGuardrailCtrl.get()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts#L46-L52)
- **Source File:** [`apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts#L46-L52)
- **Functional Summary:** Manages tenant-specific guardrail policy overrides, custom blocklists, and sensitive topic screening.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`guardrail-tenant-policy-flow.html`](guardrail-tenant-policy-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as TenantGuardrailCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Engine as Guardrail Engine Node

    Client->>GW: GET /api/v1/admin/guardrail/policy
    GW->>Ctrl: Route to get()
    Ctrl->>Svc: Invoke domain business logic
    Svc->>Engine: Evaluate Safety Rules / Probe Health
    Engine-->>Svc: Safety Verdict / Node Status
    Svc->>DB: Query / Persist Evaluation Records
    DB-->>Svc: Persisted Entity Result
    Svc-->>Ctrl: Processed Domain DTO
    Ctrl-->>GW: Formatted DTO Response
    GW-->>Client: 200 / 202 Response Payload
```

---

## 3. Code References & Verification (dev-2.2)

| Participant / Layer | Local Repository Path | Source Method / Symbol | GitHub Blob URL (`dev-2.2`) |
|---|---|---|---|
| API Gateway | `apps/api/src/main.ts` | Bootstrap & Routing | [main.ts#L1](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/main.ts#L1) |
| Controller | `apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts` | `TenantGuardrailCtrl.get()` (L46-52) | [guardrail-tenant-policy.controller.ts#L46-L52](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-tenant-policy/guardrail-tenant-policy.controller.ts#L46-L52) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **GuardrailTenantPolicyService**
- **UnifiedAuthGuard**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (TenantGuardrailPolicy, CustomBlocklist tables)
- Redis (Tenant policy cache)

---

## 5. HTTP Status Codes & Error Handling

| Status Code | Description | Condition |
|---|---|---|
| `200 OK` / `202 Accepted` | Success | Request validated, evaluated, and processed successfully. |
| `400 Bad Request` | Validation Error | Malformed body, missing required query/body fields. |
| `401 Unauthorized` | Auth Failure | Missing, expired, or malformed JWT Bearer token or service secret. |
| `403 Forbidden` | Access Denied | Insufficient permissions or tenant boundary violation. |
| `404 Not Found` | Not Found | Target evaluation entity or consultation does not exist. |
| `429 Too Many Requests` | Rate Limited | Request rate limit or token quota exceeded. |
| `500 Internal Error` | Server Failure | Unhandled exception or downstream dependency failure. |
