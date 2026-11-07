# 02. Authentication

**Sources:** [`apps/api/src/guards/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/), [`apps/api/src/app.module.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts), [`packages/applications/src/authorization/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/)

## Auth Pipeline Position
`UnifiedAuthGuard` runs **after** `TieredThrottlerGuard` and `ClsGuard`, and **before** `PatientConsentGuard`, `TenantOwnedResourceSseGuard`, `OriginTenantBindingGuard`, and `RequiresIfMatchGuard` (see [04-request-lifecycle.md](04-request-lifecycle.md), [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)).

## Credential Classes
The gateway supports multiple credential types (per [`apps/api/openapi.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/openapi.json)):

| Credential | Notes |
| --- | --- |
| **User JWT** | Standard user authentication via JWT. Subject to abilities/permissions and tenant context. |
| **Tenant API Key** | Tenant-scoped API key. Allowed on **business plane** routes only (not on `/admin/**`). API-key-reachable routes must declare `@RequiredScopes(...)`. |
| **Service Account Token** | Service account authentication. Allowed on business plane and **administration plane** (`/admin/**`). |

Scopes bind the credential; abilities bind the human the credential acts for. They compose as **AND**.

## Public Routes
Routes marked `@Public()` are the **only** opt-out from `UnifiedAuthGuard`. See [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json) for `isPublic` per route.

## Tenant Context
- Tenant context is established via CLS (`ClsGuard`).
- `OriginTenantBindingGuard` binds browser `Origin` to registered tenant and runs after auth.
- Cross-tenant access is **404, never 403** (404-over-403) — see [03-authorization.md](03-authorization.md).
