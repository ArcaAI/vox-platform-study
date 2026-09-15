# Department Service — the reference exemplar for the CRUD + OCC pattern

Application-layer service for the `Department` model (medical-specialty clinics within a tenant)
and its per-department prompt configuration. `DepartmentService` is the exemplar `04-application-services.md`
points to for the standard CRUD-with-sys-events flow. Public surface lives under
`apps/api/src/modules/department/` (`@Controller('admin/departments')`):

- `PATCH /api/v1/admin/departments/:id` — update department metadata.
- `PATCH /api/v1/admin/departments/:id/prompt-config` — assign / re-assign
  the active prompt-template version per department.

## Layout

| Path | What it holds |
|---|---|
| `department.service.ts` | `DepartmentService extends BaseService` |
| `department.service.module.ts` | `DepartmentServiceModule` — DI wiring |
| `IDepartmentService.ts` | Interface + `Symbol` injection token |
| `department.dto.mapper.ts` | Entity to Response DTO mapping |
| `dto/` | `create-department.request.ts`, `update-department.request.ts`, `update-department-prompt-config.request.ts`, `department.response.ts` |
| `__tests__/` | Vitest unit tests |

## How it works

### Concurrency model

This service uses **optimistic concurrency control**. Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.department.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` is 428; a drifted
  version is 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdateDepartmentRequest.expectedVersion`,
  `UpdateDepartmentPromptConfigRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Observability

`optimistic_lock_conflict_total{model="Department", route="<method path>"}` on
the `/metrics` endpoint (`apps/api/src/observability/metrics.ts`). Alert threshold: > 0.5 % of PATCHes.

## Gotchas

- Single-row writes only — there is no bulk PATCH for departments.
- Append-only siblings (`AuditLog`, `SysEvent`) are not version-guarded — they are write-once.
- Soft-delete bumps `_version` automatically; a write that races a soft-delete gets a 412 (correct
  — it prevents resurrecting a retired department).
- Never auto-retry a human-initiated write on a 412 — only service-to-service / Bull-job callers
  should wrap `expectedVersion` retries in `pRetry({ retries: 3, factor: 2 })` with a re-fetch
  between attempts.

## Related

- [`@arcaai/applications` README](../../../README.md) — `BaseService`, sys-event fan-out, service anatomy
- [`04-application-services.md`](../../../../../.claude/rules/04-application-services.md) — canonical CRUD flow this service exemplifies
- [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md) — ETag/If-Match OCC pattern at the controller layer
