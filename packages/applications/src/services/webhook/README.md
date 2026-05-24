# Webhook Service

Application-layer service for the `Webhook` model — outbound HTTP callbacks
that fire on `SysEvent` types subscribed per row. The service owns CRUD of
the webhook registration; the actual HTTP delivery lives in
`@arcaai/applications/src/services/notification/`.

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.webhook.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdateWebhookRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Out of scope

- Single-row writes only. There is no bulk PATCH for webhooks today.
- `WebhookRunHistory` is append-only and is not version-guarded — it is
  write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412 (correct — prevents resurrecting a disabled webhook).

### Observability

`optimistic_lock_conflict_total{model="Webhook", route="<method path>"}` on
the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
