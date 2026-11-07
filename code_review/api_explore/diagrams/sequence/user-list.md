# User Management Flow (`user-list`)

> **Interactive Diagram:** [`user-list.html`](user-list.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **user-list** workflow registered in the API Gateway.

- **Primary Route:** `GET /api/v1/admin/users`
- **Handler Method:** [`UserController.fetchAll()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/user/user.controller.ts#L158-L168)
- **Source File:** [`apps/api/src/modules/user/user.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/user/user.controller.ts#L158-L168)
- **Functional Summary:** Queries tenant users with search filters, role assignments, department bindings, activation states, and pagination.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`user-list.html`](user-list.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as UserController
    participant DB as Postgres (Prisma)

    Client->>GW: GET /api/v1/admin/users
    GW->>Ctrl: Route to fetchAll()
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
| Controller | `apps/api/src/modules/user/user.controller.ts` | `UserController.fetchAll()` (L158-168) | [user.controller.ts#L158-L168](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/user/user.controller.ts#L158-L168) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **UserService**
- **UnifiedAuthGuard**
- **PermissionsGuard (read:User)**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (User, UserRole, DepartmentMember tables)

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
