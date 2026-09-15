# Audio Pipeline (ASR) Service — deprecated, replaced by ASR Agents

Application-layer service for the `AsrPipeline` model — the per-tenant chain of audio-processing
stages (VAD to noise filter to diarization to STT provider). **Deprecated (TASK-861): removed in
R4 along with `AsrPipeline`.** ASR selection now goes through the Agent plane
(`GET /agents?task=SPEECH_TO_TEXT`, `agentSlug` on session start) — see
[`08-vox-sdk.md`](../../../../../../.claude/rules/08-vox-sdk.md) "The browser never runs a model". This service and its controllers
still serve existing reads and writes during the deprecation window; do not add new call sites
against `AsrPipeline`.

Public surface lives at `apps/api/src/modules/pipeline/`:

- `audio-pipeline.controller.ts` (`@Controller('admin/audio/pipelines')`) — admin CRUD, including
  `PATCH /api/v1/admin/audio/pipelines/:id`.
- `audio-pipeline-catalog.controller.ts` (`@Controller('audio/pipelines')`) — the read-only,
  non-admin catalog. `/** @deprecated TASK-861 */`: `GET /agents?task=SPEECH_TO_TEXT` is the
  replacement.

## Layout

| Path | What it holds |
|---|---|
| `pipeline.service.ts` | `PipelineService extends BaseService` — CRUD over `AsrPipeline` |
| `IPipelineService.ts` | Interface + `Symbol` token |
| `pipeline.dto.mapper.ts` | Entity to Response DTO mapping |
| `pipeline-template-resync.service.ts` / `pipeline-template-resync.cron.service.ts` | Template resync job and its scheduled trigger |
| `dto/` | Create/update/clone/toggle requests, `pipeline.response.ts`, `pipeline-version.response.ts` |
| `__tests__/` | Vitest unit tests |

## How it works

### Concurrency model

This service uses optimistic concurrency control. Every write to a row's mutable fields goes
through `updateWithVersion(id, entity, expectedVersion)` on the repository, which issues a Postgres
CAS via `prisma.asrPipeline.updateMany({ where: { id, version: expectedVersion }, data: { ...,
version: { increment: 1 } } })`. When `count === 0` the service re-fetches to disambiguate
`DataNotFoundException` from `OptimisticConcurrencyException`.

- **HTTP**: clients send `If-Match: "<n>"` (RFC 7232) on PATCH. The response carries `ETag: "<n+1>"`.
  Missing `If-Match` is 428; a drifted version is 412 with `{ currentVersion }`.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request body
  (`UpdatePipelineRequest.expectedVersion`). Wrap in `pRetry({ retries: 3, factor: 2 })` with a
  re-fetch between attempts. Never auto-retry human writes.

### Why OCC matters here

A streaming gateway picking up a stale `AsrPipeline` mid-edit could route audio to the wrong STT
provider — at worst leaking PHI to an unintended vendor. The OCC layer guarantees the row the
gateway dereferences matches the operator's last committed state; otherwise the gateway gets a 412
and refuses to start the session.

## Gotchas

- Single-row writes only — there is no bulk PATCH for pipelines.
- Append-only siblings (`AsrPipelineRun`, `AuditLog`) are not version-guarded — they are write-once.
- Soft-delete bumps `_version` automatically; a write that races a soft-delete gets a 412 (correct
  — it prevents resurrecting a retired pipeline).
- `optimistic_lock_conflict_total{model="AsrPipeline", route="<method path>"}` is emitted on
  `/metrics`; alert threshold is > 0.5% of PATCHes.
- Do not build new features against `AsrPipeline`/`PipelineService` — build against the Agent plane
  instead ([`08-vox-sdk.md`](../../../../../../.claude/rules/08-vox-sdk.md)).

## Related

- [`@arcaai/applications` README](../../../../README.md) — `BaseService`, sys-event fan-out
- [`08-vox-sdk.md`](../../../../../../.claude/rules/08-vox-sdk.md) — the ASR Agent replacement and the client-side-inference gate
- [`05-nestjs-api.md`](../../../../../../.claude/rules/05-nestjs-api.md) — ETag/If-Match OCC pattern
