# Consultation Listing Flow (`consultation-list`)

> **Interactive Diagram:** [`consultation-list.html`](consultation-list.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **consultation-list** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/consultations`
- **Handler Method:** [`ConsultationController.list()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L800-L810)
- **Source File:** [`apps/api/src/modules/consultation/consultation.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L800-L810)
- **Functional Summary:** Lists clinical or agent consultations with filtering by status, department, patient, date range, pagination, and multi-tenant scoping.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`consultation-list.html`](consultation-list.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as ConsultationController
    participant DB as Postgres (Prisma)

    Client->>GW: GET /api/v1/consultations
    GW->>Ctrl: Route to list()
    Ctrl->>DB: Perform Database Operations
    DB-->>Ctrl: Entity / State Result
    Ctrl-->>GW: Formatted DTO Response
    GW-->>Client: 200 / 201 Response Payload
```

---

## 3. Code References & Verification (dev-2.2)

| Participant / Layer | Local Repository Path | Source Method / Symbol | GitHub Blob URL (`dev-2.2`) |
|---|---|---|---|
| API Gateway | `apps/api/src/main.ts` | Bootstrap & Routing | [main.ts#L1](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/main.ts#L1) |
| Controller | `apps/api/src/modules/consultation/consultation.controller.ts` | `ConsultationController.list()` (L800-810) | [consultation.controller.ts#L800-L810](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L800-L810) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **ConsultationService**
- **UnifiedAuthGuard**
- **PermissionsGuard (read:Consultation)**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (Consultation, Department, Patient tables)
- Redis (Query cache)

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
