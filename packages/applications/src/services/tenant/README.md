# Tenant Service

Application-layer service for tenant lifecycle, including the per-tenant
configuration store consumed by `TenantConfigManager`. Public surface lives
under `apps/api/src/modules/tenant/`:

- `@Controller('admin/tenants')` — admin CRUD over the Tenant model.
- `@Controller('tenant')` — `me`-scoped self-management
  (`PATCH /api/v1/tenants/me`, `PATCH /api/v1/tenants/me/config`).

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.tenant.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException` and surface the correct status to the caller.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdateTenantRequest.expectedVersion`, `UpdateTenantConfigRequest.expectedVersion`).
  Wrap in `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Bulk writes

`TenantService.updateTenantConfigs` writes multiple `GlobalSetting` rows in a
single `PATCH /api/v1/tenants/me/config`. The whole batch is atomic under a
single `$transaction`: any single 412 rolls every row back; the caller
re-fetches all rows before re-submitting (the SDK's `ConfigManager` does
this automatically via the typed `ConfigConflictError`).

### Out of scope

- Append-only siblings (`TenantUsageRecord`, `AuditLog`) are not
  version-guarded — they are write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412 (correct — resurrection is prevented).

### Read replicas

Admin reads must hit the primary. Replica lag would otherwise cause every save
to 412 against a stale `version`. The service does not currently route reads
to replicas; documented here to forestall the future regression.

### Observability

`optimistic_lock_conflict_total{model="Tenant", route="<method path>"}` on the
`/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
