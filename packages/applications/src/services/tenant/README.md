# Tenant Service — tenant lifecycle and the `GlobalSetting` config store

Application-layer service for tenant lifecycle (`Tenant` model) and the per-tenant `GlobalSetting`
config store. Public surface is split across several controllers in `apps/api/src/modules/tenant/`:

- `tenant.controller.ts` (`@Controller('admin/tenants')`) — admin CRUD: `PATCH /:id`,
  `DELETE /:id`, `PATCH /configs/:identifier` (bulk config write by tenant id or code name),
  `POST /:id/suspend`, `/:id/archive`, `/:id/restore`, and more.
- `my-tenant.controller.ts` (`@Controller('tenants/me')`) — self-service reads (`GET`,
  `GET /config`) and the one mutating route, `PATCH /config` (`updateMyConfig`), scoped to the
  caller's CLS tenant context.
- `my-tenant-redirect.shim.controller.ts` (`@Controller('tenant')`) — 308 redirect shim for the
  retired singular `tenant/me[/config]` paths to `tenants/me[/config]`; marked for deletion in
  ALL-2.0.0.

## Layout

| Path | What it holds |
|---|---|
| `tenant.service.ts` | `TenantService extends BaseService` — lifecycle CRUD, `updateTenantConfigs`, usage stats |
| `ITenantService.ts` | Interface + `Symbol` token |
| `tenant.dto.mapper.ts`, `tenantConfig.dto.mapper.ts` | Entity to Response DTO mapping (tenant, config rows) |
| `dto/` | Tenant and `TenantConfig` request/response DTOs, including `UpdateTenantConfigRequest` |
| `onboarding/` | `TenantOnboardingService` — the tenant-creation flow (reference-set cloning, defaults) |
| `reference-set/` | `TenantReferenceSetService` — clones the SYSTEM content reference set into a new tenant; also backs `POST admin/tenants/:id/reference-set/sync` |
| `validators/` | `not-reserved-tenant-key.validator.ts` — rejects reserved tenant identifiers |
| `__tests__/` | Vitest unit tests |

## How it works

### Concurrency model

Writes go through `updateWithVersion(id, entity, expectedVersion)` on the repository, issuing a
Postgres CAS (`prisma.tenant.updateMany({ where: { id, version: expectedVersion }, ... })`). HTTP
clients send `If-Match: "<n>"` on PATCH; missing `If-Match` is 428, a drifted version is 412 with
`{ currentVersion }`. Service-to-service callers pass `expectedVersion` in the request body instead
and should re-fetch and retry with backoff — never auto-retry a human-initiated write.

### Bulk config writes

`TenantService.updateTenantConfigs` writes multiple `GlobalSetting` rows in one call, reached from
both `PATCH admin/tenants/configs/:identifier` (admin, by tenant id or code name) and
`PATCH tenants/me/config` (self-service, scoped to the CLS tenant). The whole batch is atomic under
a single `$transaction`: any single 412 rolls every row back, and the caller re-fetches all rows
before re-submitting. On the self-service route, an `If-Match` header (when present) applies as the
`expectedVersion` for EVERY row in the request — the documented pattern is `If-Match: "<min(versions)>"`
for bulk updates.

### Read replicas

Admin reads must hit the primary. Replica lag would otherwise cause every save to 412 against a
stale `version`. The service does not currently route reads to replicas.

## Gotchas

- Append-only siblings (`TenantUsageRecord`, `AuditLog`) are not version-guarded — they are
  write-once.
- Soft-delete bumps `_version` automatically; a write that races a soft-delete gets a 412 (correct
  — it prevents resurrecting a suspended/archived tenant).
- The global `ValidationPipe` does not validate top-level array bodies element-wise, so both
  `updateTenantConfigs` call sites hand-forward only the mutable fields (`id`, `value`,
  `description`, `expectedVersion`) rather than trusting the raw request array — a smuggled
  `tenantId`/`locked`/`key` field is not caught by the pipe.
- `PATCH tenant/me/config` (singular) is a 308 redirect, not a live endpoint — the real route is
  `PATCH tenants/me/config` (plural).

## Related

- [`@arcaai/applications` README](../../../README.md) — `BaseService`, sys-event fan-out
- [GlobalSetting service README](../globalSetting/README.md) — the `GlobalSetting` model these config rows are
- [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md) — ETag/If-Match OCC pattern
