# Audio Pipeline (ASR) Service

Application-layer service for the `AsrPipeline` model — the per-tenant
chain of audio-processing stages (VAD → noise filter → diarization → STT
provider) consumed by the streaming gateway and the consultation
worker. Public surface lives at `apps/api/src/modules/pipeline/`
(`@Controller('admin/audio/pipelines')`):

- `PATCH /api/v1/admin/audio/pipelines/:id` — edit the stage list, model
  selection, or sample-rate config.

## Concurrency Model

This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
write to a row's mutable fields goes through
`updateWithVersion(id, entity, expectedVersion)` on the repository, which issues
a Postgres CAS via
`prisma.asrPipeline.updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })`.
When `count === 0` we re-fetch to disambiguate `DataNotFoundException` from
`OptimisticConcurrencyException`.

### Inbound contract

- **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
  response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
  → 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
  body (`UpdatePipelineRequest.expectedVersion`). Wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts.
  **Never auto-retry human writes.**

### Why this matters here

A streaming gateway picking up a stale `AsrPipeline` mid-edit can route audio
to the wrong STT provider — at worst leaking PHI to an unintended vendor. The
OCC layer guarantees the row the gateway dereferences matches the operator's
last committed state; otherwise the gateway gets a 412 and refuses to start
the session.

### Out of scope

- Single-row writes only. There is no bulk PATCH for pipelines today.
- Append-only siblings (`AsrPipelineRun`, `AuditLog`) are not version-guarded —
  they are write-once.
- Soft-delete bumps `_version` automatically; calls that race a soft-delete
  get a 412 (correct — prevents resurrecting a retired pipeline).

### Observability

`optimistic_lock_conflict_total{model="AsrPipeline", route="<method path>"}` on
the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

### References

- [TASK-302 Stream D plan](../../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
- [Research doc](../../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
