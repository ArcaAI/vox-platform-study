# Department Service

Application-layer service for the `Department` model (medical-specialty
clinics within a tenant) and its per-department prompt configuration.
Public surface lives under
`apps/api/src/modules/department/` (`@Controller('admin/departments')`):

- `PATCH /api/v1/admin/departments/:id` — update department metadata.
- `PATCH /api/v1/admin/departments/:id/prompt-config` — assign / re-assign
  the active prompt-template version per department.

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.department.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdateDepartmentRequest.expectedVersion`,
  `UpdateDepartmentPromptConfigRequest.expectedVersion`,
  `AssignDepartmentPromptRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Out of scope

- Single-row writes only. There is no bulk PATCH for departments today.
- Append-only siblings (`AuditLog`, `SysEvent`) are not version-guarded —
  they are write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412 (correct — resurrection is prevented).

### Observability

`optimistic_lock_conflict_total{model="Department", route="<method path>"}` on
the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
