# Consultation Summary & SOAP Generation Flow (`consultation-summary-flow`)

> **Interactive Diagram:** [`consultation-summary-flow.html`](consultation-summary-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **consultation-summary-flow** workflow registered in the API Gateway.

- **Primary Route:** `POST /api/v1/consultations/{id}/summary`
- **Handler Method:** [`ConsultSummaryCtrl.getSummary()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2210-L2220)
- **Source File:** [`apps/api/src/modules/consultation/consultation.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2210-L2220)
- **Functional Summary:** Generates or retrieves synthesized clinical summaries, SOAP notes, and encounter recaps using LLM summarization.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`consultation-summary-flow.html`](consultation-summary-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as ConsultSummaryCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Ext as Cloud / Downstream Service

    Client->>GW: POST /api/v1/consultations/{id}/summary
    GW->>Ctrl: Route to getSummary()
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
| Controller | `apps/api/src/modules/consultation/consultation.controller.ts` | `ConsultSummaryCtrl.getSummary()` (L2210-2220) | [consultation.controller.ts#L2210-L2220](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2210-L2220) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **ConsultationSummaryService**
- **ClinicalSummarizationAgent**
- **UnifiedAuthGuard**

### Data Stores & External Systems
- LLM Provider (Medical Summarization model)
- PostgreSQL (ConsultationSummary table)
- Redis (Job lock)

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
