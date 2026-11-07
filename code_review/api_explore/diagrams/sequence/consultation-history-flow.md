# Consultation History & Activity Timeline Flow (`consultation-history-flow`)

> **Interactive Diagram:** [`consultation-history-flow.html`](consultation-history-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **consultation-history-flow** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/consultations/{id}/activity`
- **Handler Method:** [`ConsultHistoryCtrl.getActivity()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts#L56-L64)
- **Source File:** [`apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts#L56-L64)
- **Functional Summary:** Chronological activity timeline tracking user edits, AI generation steps, audio revisions, and export history.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`consultation-history-flow.html`](consultation-history-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as ConsultHistoryCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Ext as Cloud / Downstream Service

    Client->>GW: GET /api/v1/admin/consultations/{id}/activity
    GW->>Ctrl: Route to getActivity()
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
| Controller | `apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts` | `ConsultHistoryCtrl.getActivity()` (L56-64) | [admin-consultation-history.controller.ts#L56-L64](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation-history/admin-consultation-history.controller.ts#L56-L64) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **ConsultationHistoryService**
- **UnifiedAuthGuard**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (ConsultationActivity, AuditEvent tables)

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
