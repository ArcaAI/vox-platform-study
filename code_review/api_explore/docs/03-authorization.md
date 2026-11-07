# 03. Authorization

**Sources:** [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md), [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json), [`packages/applications/src/authorization/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/)

## Planes
- **Business plane** — tenant-facing. Reachable with user JWT, tenant API key, or service account token.
- **Administration plane** (`/api/v1/admin/**`) — reachable with user JWT or service account token **only**. Every admin route carries `@ForbidApiKey()` and is enforced before scope/ability checks.

## Authorization Decorators
From [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) (decorators re-exported from `@arcaai/applications`):
- `@Public()` — opt out of auth
- `@Authorize(['manage', 'Department'])`, `@AuthorizeAny()` — CASL/ability checks
- `@CanRead/CanList/CanCreate/CanUpdate/CanDelete/CanManage('Resource')`, `@CanAny/CanAll()`
- Class-level `@CanManage('X')` can gate a whole admin controller
- `@RequiredScopes(...)` — API key/service account scope requirements
- `@ForbidApiKey()` — block API keys (used on admin plane)

## 404-over-403 (Tenant Isolation)
Cross-tenant access is always **404, never 403**. There are documented exceptions for super-admin-only privilege gates on specific routes (see [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) and `.claude/rules/05-nestjs-api.md`).

## Boot-Time Authorization Audits
`main.ts` runs audits that refuse to start on drift:
- Every route must carry `@Public()` or a permission decorator
- Every API-key-reachable route must declare `@RequiredScopes(...)`
- `/internal/*` routes must sit off the API-key surface
- Admin controllers must declare no API-key scopes and must carry `@ForbidApiKey()`
- `:patientId` routes must carry a consent decorator
- Service-account surface must not leak into JWT or API-key surfaces
- WebSocket gateways must be classified for caller ownership
- CASL-enforced pairs must be able to actually produce their denial

See [`apps/api/src/bootstrap/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/) and [19-boot-time-audits.md](19-boot-time-audits.md).
