# Rate Limit Management Flow (`rate-limit-management-flow`)

> **Interactive Diagram:** [`rate-limit-management-flow.html`](rate-limit-management-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **rate-limit-management-flow** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/rate-limit`
- **Handler Method:** [`RateLimitAdminCtrl.getPolicy()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts#L71-L75)
- **Source File:** [`apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts#L71-L75)
- **Functional Summary:** Administrative retrieval and dynamic reconfiguration of tenant tier request rate limits, token quotas, and sliding window thresholds.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`rate-limit-management-flow.html`](rate-limit-management-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as RateLimitAdminCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Redis as Redis Cache

    Client->>GW: GET /api/v1/admin/rate-limit
    GW->>Ctrl: Route to getPolicy()
    Ctrl->>Svc: Invoke domain business logic
    Svc->>DB: Query / Mutate Entity Records
    DB-->>Svc: Entity / State Result
    Svc-->>Ctrl: Processed Domain DTO
    Ctrl-->>GW: Formatted DTO Response
    GW-->>Client: 200 / 201 Response Payload
```

---

## 3. Code References & Verification (dev-2.2)

| Participant / Layer | Local Repository Path | Source Method / Symbol | GitHub Blob URL (`dev-2.2`) |
|---|---|---|---|
| API Gateway | `apps/api/src/main.ts` | Bootstrap & Routing | [main.ts#L1](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/main.ts#L1) |
| Controller | `apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts` | `RateLimitAdminCtrl.getPolicy()` (L71-75) | [rate-limit-admin.controller.ts#L71-L75](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts#L71-L75) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **RateLimitAdminService**
- **RateLimitEnforcementGuard**
- **UnifiedAuthGuard**

### Data Stores & External Systems
- Redis (Sliding window rate limit counters & policy cache)
- PostgreSQL (TenantRateLimitPolicy table)

---

## 5. HTTP Status Codes & Error Handling

| Status Code | Description | Condition |
|---|---|---|
| `200 OK` / `201 Created` / `202 Accepted` | Success | Request validated, authenticated, and executed successfully. |
| `400 Bad Request` | Validation Error | Malformed body, missing required query/body fields. |
| `401 Unauthorized` | Auth Failure | Missing, expired, or malformed JWT Bearer token. |
| `403 Forbidden` | Access Denied | Insufficient permissions or tenant boundary violation. |
| `404 Not Found` | Not Found | Target entity or route does not exist. |
| `429 Too Many Requests` | Rate Limited | Request rate limit or token quota exceeded. |
| `500 Internal Error` | Server Failure | Unhandled exception or downstream dependency failure. |
