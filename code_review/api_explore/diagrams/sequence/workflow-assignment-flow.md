# Workflow Assignment & Routing Flow (`workflow-assignment-flow`)

> **Interactive Diagram:** [`workflow-assignment-flow.html`](workflow-assignment-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **workflow-assignment-flow** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/workflow-assignments`
- **Handler Method:** [`WorkflowAssignCtrl.fetchAll()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts#L36-L45)
- **Source File:** [`apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts#L36-L45)
- **Functional Summary:** Tenant and user workflow assignments, department-level routing triggers, and assignment hierarchies.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`workflow-assignment-flow.html`](workflow-assignment-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as WorkflowAssignCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Engine as Workflow / Sandbox Engine

    Client->>GW: GET /api/v1/admin/workflow-assignments
    GW->>Ctrl: Route to fetchAll()
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
| Controller | `apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts` | `WorkflowAssignCtrl.fetchAll()` (L36-45) | [workflow-assignment.controller.ts#L36-L45](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/workflow-assignment/workflow-assignment.controller.ts#L36-L45) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **WorkflowAssignmentService**
- **UnifiedAuthGuard**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (WorkflowAssignment, DepartmentScope tables)

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
