# GlobalSetting Service

Application-layer service for the `__GLOBAL__`-tenant configuration rows
(SUPER_ADMIN-edited platform-wide flags) and the per-tenant overlay rows
(`tenantId != '__GLOBAL__'`). Reads are layered (per-tenant row → `__GLOBAL__`
row → env default), and the in-process cache is invalidated by SysEvents when
a row mutates.

The HTTP surface for SUPER_ADMIN edits is the play-studio area
(`apps/api/src/modules/pstudio/`); per-tenant edits flow through
`TenantService.updateTenantConfigs` (`PATCH /api/v1/tenant/me/config`).

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.globalSetting.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`. The SDK's `ConfigManager` captures the
  `ETag` on read and replays it on the next write.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdateGlobalSettingRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Bulk writes

`TenantService.updateTenantConfigs` is the canonical bulk-edit path and wraps
the whole batch in a single `$transaction`. Any single 412 rolls every row
back; the caller re-fetches all rows before re-submitting. See the Tenant
service README for the full bulk-write semantics.

### Audit-log correlation

Every successful CAS broadcasts `SysEvent.ResourceUpdated` with
`previousVersion` and `newVersion` in the payload. Investigators reconstruct
history via `SELECT … FROM "sysEvent" WHERE metadata->>'newVersion' = ?`.

### Out of scope

- Append-only siblings (`GlobalSettingHistory` when TASK-3XX lands,
  `AuditLog`) are not version-guarded — they are write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412.

### Observability

`optimistic_lock_conflict_total{model="GlobalSetting", route="<method path>"}`
on the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
