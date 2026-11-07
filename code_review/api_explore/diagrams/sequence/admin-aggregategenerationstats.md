# Aggregategenerationstats Flow (`admin-aggregategenerationstats`)

> **Interactive Diagram:** [`admin-aggregategenerationstats.html`](admin-aggregategenerationstats.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **aggregateGenerationStats** workflow registered in the API Gateway.

- **Primary Route:** `/api/v1/admin/agent-trajectory/metrics/generation`
- **Handler Method:** [`agent-trajectory.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L57-L63)
- **Source File:** [`src/modules/agent-trajectory/agent-trajectory.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L57-L63)
- **Functional Summary:** Aggregate GenerationStats across LLM_CALL trajectory steps (TTFT median/p95, tok/s avg, stop-reason histogram). Bounded window (default last 7d) + hard row cap.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`admin-aggregategenerationstats.html`](admin-aggregategenerationstats.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as aggregateGenerationStatsController
    participant DB as Postgres (Prisma)

    Client->>GW: aggregateGenerationStats /api/v1/admin/agent-trajectory/metrics/generation
    GW->>Ctrl: Route to aggregategenerationstats()
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
| Controller | `src/modules/agent-trajectory/agent-trajectory.controller.ts` | `aggregateGenerationStats` (L57-L63) | [agent-trajectory.controller.ts#57-L63](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L57-L63) |

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
