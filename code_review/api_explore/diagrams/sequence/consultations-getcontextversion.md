# Getcontextversion Flow (`consultations-getcontextversion`)

> **Interactive Diagram:** [`consultations-getcontextversion.html`](consultations-getcontextversion.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **getContextVersion** workflow registered in the API Gateway.

- **Primary Route:** `/api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}`
- **Handler Method:** [`consultation.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2074-L2080)
- **Source File:** [`src/modules/consultation/consultation.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2074-L2080)
- **Functional Summary:** Retrieving a single ContextItemVersionResponse by id and contextId and versionNumber

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`consultations-getcontextversion.html`](consultations-getcontextversion.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as getContextVersionController
    participant DB as Postgres (Prisma)

    Client->>GW: getContextVersion /api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}
    GW->>Ctrl: Route to getcontextversion()
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
| Controller | `src/modules/consultation/consultation.controller.ts` | `getContextVersion` (L2074-L2080) | [consultation.controller.ts#2074-L2080](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts#L2074-L2080) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **Service1**
- **Service2**

### Data Stores & External Systems
- PostgreSQL (Main data)
- Redis (Cache, session context)
- LLM Provider (OpenAI/Anthropic/Local)

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
