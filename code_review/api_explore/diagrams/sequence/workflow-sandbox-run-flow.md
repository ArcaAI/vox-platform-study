# Workflow Sandbox Run & Debug Flow (`workflow-sandbox-run-flow`)

> **Interactive Diagram:** [`workflow-sandbox-run-flow.html`](workflow-sandbox-run-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **workflow-sandbox-run-flow** workflow registered in the API Gateway.

- **Primary Route:** `POST /api/v1/admin/workflow-definitions/{id}/sandbox-runs`
- **Handler Method:** [`SandboxRunCtrl.start()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts#L65-L75)
- **Source File:** [`apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts#L65-L75)
- **Functional Summary:** Isolated sandbox execution of draft workflow definitions with synthetic mock inputs and live SSE stream debugging.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`workflow-sandbox-run-flow.html`](workflow-sandbox-run-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as SandboxRunCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Engine as Workflow / Sandbox Engine

    Client->>GW: POST /api/v1/admin/workflow-definitions/{id}/sandbox-runs
    GW->>Ctrl: Route to start()
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
| Controller | `apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts` | `SandboxRunCtrl.start()` (L65-75) | [workflow-sandbox-run.controller.ts#L65-L75](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts#L65-L75) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **WorkflowSandboxRunService**
- **SandboxRunnerService**
- **UnifiedAuthGuard**

### Data Stores & External Systems
- Docker / Ephemeral Container Sandbox
- Redis (SSE event pub/sub)
- PostgreSQL (WorkflowSandboxRun table)

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
