# Catalogue Flow (`admin-catalogue`)

> **Interactive Diagram:** [`admin-catalogue.html`](admin-catalogue.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **catalogue** workflow registered in the API Gateway.

- **Primary Route:** `/api/v1/admin/model-residency/catalogue`
- **Handler Method:** [`model-residency.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/model-residency/model-residency.controller.ts#L100-L101)
- **Source File:** [`src/modules/model-residency/model-residency.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/model-residency/model-residency.controller.ts#L100-L101)
- **Functional Summary:** Read every loadable model per service, loaded or not, and who uses it

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`admin-catalogue.html`](admin-catalogue.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as catalogueController
    participant DB as Postgres (Prisma)

    Client->>GW: catalogue /api/v1/admin/model-residency/catalogue
    GW->>Ctrl: Route to catalogue()
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
| Controller | `src/modules/model-residency/model-residency.controller.ts` | `catalogue` (L100-L101) | [model-residency.controller.ts#100-L101](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/model-residency/model-residency.controller.ts#L100-L101) |

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
