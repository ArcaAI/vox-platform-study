# Prompt Management Service

Application-layer service for `PromptTemplate` and the per-template
versioning chain (a separate, application-domain concept from the
database-owned `_version` OCC token — see below). Public surface lives at
`apps/api/src/modules/prompt-management/`
(`@Controller('prompt-templates')`):

- `PATCH /api/v1/prompt-templates/:id` — edit template metadata / latest draft.
- `POST /api/v1/prompt-templates/:id/versions/:n/activate` — promote a
  historical version to `currentVersionNumber`.

> **Two "version" concepts.** `PromptTemplate.currentVersionNumber` is a
> *domain* notion: which historical revision is currently published. The
> database-owned `_version` exposed on the response as `version: number` is
> the OCC token. The two are independent and update on different events.

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.promptTemplate.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`.
- **`activateVersion` (server-driven OCC)**: the controller fetches the
  current template, reads its `_version`, and feeds it to
  `updatePromptTemplate(..., { expectedVersion })`. Callers do **not** pass
  `expectedVersion` for this endpoint — the operation is read-modify-write
  on the server side.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdatePromptTemplateRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Out of scope

- Single-row writes only. There is no bulk PATCH for templates today.
- Append-only siblings (`PromptTemplateVersion`, `AuditLog`) are not
  version-guarded — they are write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412 (correct — resurrection is prevented).

### Observability

`optimistic_lock_conflict_total{model="PromptTemplate", route="<method path>"}`
on the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
