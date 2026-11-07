# Agent Trajectory & Generation Metrics Flow (`agent-trajectory-flow`)

> **Interactive Diagram:** [`agent-trajectory-flow.html`](agent-trajectory-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **agent-trajectory-flow** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/agent-trajectory/sessions`
- **Handler Method:** [`TrajectoryCtrl.listSessions()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L76-L80)
- **Source File:** [`apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L76-L80)
- **Functional Summary:** Deep trajectory inspection, reasoning trace logging, tool-call timeline auditing, and token latency telemetry for agent runs.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`agent-trajectory-flow.html`](agent-trajectory-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as TrajectoryCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Redis as Redis Cache

    Client->>GW: GET /api/v1/admin/agent-trajectory/sessions
    GW->>Ctrl: Route to listSessions()
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
| Controller | `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts` | `TrajectoryCtrl.listSessions()` (L76-80) | [agent-trajectory.controller.ts#L76-L80](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts#L76-L80) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **AgentTrajectoryService**
- **TrajectoryAnalyticsService**
- **UnifiedAuthGuard**

### Data Stores & External Systems
- PostgreSQL (AgentTrajectory, AgentStep, ToolExecution tables)
- S3 / Blob Storage (Trace artifacts)

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
