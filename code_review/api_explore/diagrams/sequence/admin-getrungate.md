# Getrungate Flow (`admin-getrungate`)

> **Interactive Diagram:** [`admin-getrungate.html`](admin-getrungate.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **getRunGate** workflow registered in the API Gateway.

- **Primary Route:** `/api/v1/admin/workflow-runs/{runId}/gate`
- **Handler Method:** [`workflow-run.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/workflow-run/workflow-run.controller.ts#L140-L142)
- **Source File:** [`src/modules/workflow-run/workflow-run.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/workflow-run/workflow-run.controller.ts#L140-L142)
- **Functional Summary:** Live state of the run's human-approval gate, read from the gate child workflow. Cross-tenant / nonexistent id → 404.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`admin-getrungate.html`](admin-getrungate.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as getRunGateController
    participant DB as Postgres (Prisma)

    Client->>GW: getRunGate /api/v1/admin/workflow-runs/{runId}/gate
    GW->>Ctrl: Route to getrungate()
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
| Controller | `src/modules/workflow-run/workflow-run.controller.ts` | `getRunGate` (L140-L142) | [workflow-run.controller.ts#140-L142](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/workflow-run/workflow-run.controller.ts#L140-L142) |

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
