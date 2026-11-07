# Changelog Management Flow (`changelog-flow`)

> **Interactive Diagram:** [`changelog-flow.html`](changelog-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **changelog-flow** workflow registered in the API Gateway.

- **Primary Route:** `POST /api/v1/admin/changelog`
- **Handler Method:** [`ChangelogAdminCtrl.create()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/changelog/changelog-admin.controller.ts#L56-L60)
- **Source File:** [`apps/api/src/modules/changelog/changelog-admin.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/changelog/changelog-admin.controller.ts#L56-L60)
- **Functional Summary:** Tracks platform schema evolutions, service release notes, migration events, and configuration version changes.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`changelog-flow.html`](changelog-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as ChangelogAdminCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Redis as Redis Cache

    Client->>GW: POST /api/v1/admin/changelog
    GW->>Ctrl: Route to create()
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
| Controller | `apps/api/src/modules/changelog/changelog-admin.controller.ts` | `ChangelogAdminCtrl.create()` (L56-60) | [changelog-admin.controller.ts#L56-L60](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/changelog/changelog-admin.controller.ts#L56-L60) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **ChangelogAdminService**
- **UnifiedAuthGuard**
- **PermissionsGuard**

### Data Stores & External Systems
- PostgreSQL (Changelog, ReleaseNote tables)

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
