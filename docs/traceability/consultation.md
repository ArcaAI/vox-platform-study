# Traceability — Consultations & Clinical Context

The consultation aggregate and everything hung off it: the consultation lifecycle
(open / close / reopen / chain), clinical context items (transcriptions, case notes,
versions), the consultation timeline, highlights, aggregate named-entity reads, audio
recording + media persistence, and live documentation (the running SOAP note streamed
during recording). Migrates legacy matrix rows **9**, **12**, and **16**.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Summary generation, prompt resolution, and harness gating all mount their routes on the
same `ConsultationController`, but they belong to other domains: the `:id/summary*` routes
are in [`summarization.md`](./summarization.md); the `:id/harness-*/stream`,
`:id/trajectory/stream`, and `:id/summary/:contextItemId/approve` routes are in
[`harness.md`](./harness.md). Only the lifecycle / context / timeline / highlight /
recording / named-entity / live-documentation surfaces are recorded here.

## Capabilities

### C1 — Consultation lifecycle (open / close / reopen / chain, patient history) — legacy row 9

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/consultation` (`consultation.controller.ts`, `admin-consultation.controller.ts`); `packages/applications/src/services/consultation/consultation` (`consultation.service.ts`, `consultation.dto.mapper.ts`) |
| Prisma models | `Consultation` (`db_main/consultation.prisma`) |
| Key API endpoints | `@Controller('consultations')` (`@Authorize()` class-level): `POST /consultations/open` (get-or-create), `GET /consultations/:id`, `PATCH /consultations/:id`, `POST /consultations/:id/close`, `POST /consultations/:id/reopen`, `GET /consultations/:id/chain`, `GET /consultations/patient/:patientId/history`, `GET /consultations/patient/:patientId/date/:date`. `@Controller('admin/consultations')`: `GET ''` (fetch-all, cross-tenant admin read), `GET /admin/consultations/aggregate`, `GET /admin/consultations/:id` |
| Console | `apps/admin-console` feature `consultations` (`consultations-screen`), route `/consultations` (tier 30–49, tenant-scoped); read-only detail `consultation-review` (`consultation-review-screen`), route `/consultation-review` |
| Tests | unit(app): `consultation/consultation/__tests__/{consultation.service,consultation.dto.mapper,consultation.list-with-relations}.test.ts`; unit(api): `consultation/__tests__/{consultation.controller,admin-consultation.controller}.test.ts`; unit(console): `consultations/components/__tests__/consultations-screen.test.tsx`, `consultation-review/components/__tests__/consultation-review-screen.test.tsx`; e2e: `admin-fetchall-cross-tenant.spec.ts` |

### C2 — Clinical context items & versions (transcriptions, case notes) — legacy row 9

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/consultation` (context routes on `consultation.controller.ts`); `packages/applications/src/services/consultation/context` (`context.service.ts`, `context.dto.mapper.ts`) |
| Prisma models | `ContextItem`, `ContextItemVersion` (`db_main/consultation.prisma`) — context payloads are envelope-encrypted at rest |
| Key API endpoints | `POST /consultations/:id/context`, `GET /consultations/:id/context`, `GET /consultations/:id/context/shared`, `GET /consultations/:id/context/transcriptions`, `GET /consultations/:id/context/case-notes`, `PATCH /consultations/:id/context/:contextId`, `DELETE /consultations/:id/context/:contextId`, `GET /consultations/:id/context/:contextId/versions`, `GET /consultations/:id/context/:contextId/versions/:versionNumber` |
| Console | surfaced within `consultation-review` (read-only clinical context) |
| Tests | unit(app): `consultation/context/__tests__/{context.service,context.dto.mapper,context.service.context-added,context.service.encryption}.test.ts` |

### C3 — Consultation timeline — legacy row 9

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `packages/applications/src/services/consultation/timeline` (`timeline.service.ts`) |
| Prisma models | `ContextItem`, `AudioRecording`, `Highlight`, `SummaryMeta` (composed read; no timeline-specific model) |
| Key API endpoints | `GET /consultations/:id/timeline` (`?scope=single|chain`, default `chain`) |
| Tests | unit(app): `consultation/timeline/__tests__/timeline.service.test.ts` |

### C4 — Highlights — legacy row 9

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `packages/applications/src/services/consultation/highlight` (`highlight.service.ts`, `highlight.dto.mapper.ts`) |
| Prisma models | `Highlight` (`db_main/consultation.prisma`) — highlight text envelope-encrypted |
| Key API endpoints | `POST /consultations/:id/highlights`, `GET /consultations/:id/highlights`, `DELETE /consultations/:id/highlights/:highlightId` |
| Tests | unit(app): `consultation/highlight/__tests__/{highlight.service,highlight.service.encryption}.test.ts`; unit(api): `consultation/__tests__/consultation.controller.highlights.test.ts` |

### C5 — Aggregate named-entity read (clinical context) — legacy row 9

Read-only aggregation of the `NamedEntity` rows the NLP pipeline persisted (extraction
itself lives in the medical-NLP domain / SMR-driven `extract-entities` in
[`summarization.md`](./summarization.md)).

| Field | Value |
|---|---|
| App / service | `apps/api` (reads NLP-populated entities) |
| Key modules | `apps/api/src/modules/consultation` (`getNamedEntities` on `consultation.controller.ts` → `context.service.getAggregateNamedEntities`) |
| Prisma models | `NamedEntity` (`db_main/consultation.prisma`) |
| Key API endpoints | `GET /consultations/:id/named-entities` (`?scope=single|chain`, default `single`) |
| Tests | unit(app): covered by the `context` service suite (aggregate-NER path) |

### C6 — Recording capture & media persistence — legacy row 12

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt-v2` + MinIO |
| Key modules | `apps/api/src/modules/consultation` (recording routes on `consultation.controller.ts`); `apps/api/src/modules/internal` (`stt-internal.controller.ts` — STT-v2 callbacks); `packages/applications/src/services/consultation/context` (audio-recording persistence) |
| Prisma models | `AudioRecording` (`db_main/consultation.prisma`), `Media` (`db_main/media.prisma`), `TenantBucket` (`db_main/*` storage domain) |
| Key API endpoints | `POST /consultations/:id/recording/start`, `POST /consultations/:id/recording/stop`, `POST /consultations/:id/recordings` (register), `GET /consultations/:id/recordings`; internal callbacks `@Controller('internal/stt')` → `POST /internal/stt/audio-records`, `POST /internal/stt/media` |
| Tests | unit(app): `consultation/consultation/__tests__/consultation.service.recording.test.ts`; unit(api): `internal` STT-callback tests, `consultation.controller` recording paths |

### C7 — Live documentation (running SOAP note during recording) — legacy row 16

| Field | Value |
|---|---|
| App / service | `apps/api` (+ SMR generation, NLP entities) |
| Key modules | `packages/applications/src/services/consultation/live-documentation` (`live-documentation.service.ts`, `soap-parser.ts`) |
| Prisma models | `ContextItem` — the running note is a `PRE_SUMMARY` snapshot tagged `metadata.subType = LIVE_SOAP_SNAPSHOT` |
| Key API endpoints | SSE `GET /consultations/:id/live-summary/stream` (`@Sse()` on `consultation.controller.ts`) |
| Console | consumed by the playground live-transcription surface (running note panel) |
| Tests | unit(app): `consultation/live-documentation/__tests__/{live-documentation.service,soap-parser,live-documentation.windowed,live-documentation.groundedness,live-documentation.repair,live-documentation.prompt-cache,live-documentation.agentic-context,live-documentation.repoint-grounding,live-documentation.trajectory}.test.ts`. The `agentic-context`, `repoint-grounding`, and `trajectory` suites cover the TASK-533 agentic-loop wiring (post-2026-07-06) |

### C8 — Async consultation jobs (generation job tracking)

Client-facing polling/streaming surface for the BullMQ jobs that back async summary /
documentation generation. The jobs themselves are enqueued by the summarization domain.

| Field | Value |
|---|---|
| App / service | `apps/api` + BullMQ (Redis) |
| Key modules | `apps/api/src/modules/consultation` (`consultation-job.controller.ts`); `packages/applications/src/services/consultation/jobs` (`consultation-job.service.ts`, `processors/`) |
| Prisma models | — (job state in Redis/BullMQ; results land as `ContextItem` / `SummaryMeta`) |
| Key API endpoints | `@Controller('consultations/jobs')`: `GET /consultations/jobs/:jobId`, `PATCH /consultations/jobs/:jobId/cancel`, SSE `GET /consultations/jobs/:jobId/stream` |
| Tests | unit(app): `consultation/jobs/__tests__/*`; unit(api): `consultation/__tests__/consultation-job.controller.test.ts`; e2e: `consultation-jobs.e2e-spec.ts`, `consultation-job-cross-user.spec.ts`, `consultation-job-cross-tenant.spec.ts` |

## Honest notes / gaps

- **No dedicated context/timeline/highlight/named-entity e2e.** C2–C5 are covered at the unit(app)/unit(api) layers; the only consultation e2e specs are the job suites (C8) and the admin fetch-all cross-tenant spec (C1). Recording round-trips (C6) have unit coverage but no live-DB + MinIO e2e.
- **Named-entity extraction is not in this domain.** C5 only *reads* aggregated `NamedEntity` rows; population happens via the NLP service and the SMR-driven `POST /consultations/:id/summary/:contextItemId/extract-entities` route ([`summarization.md`](./summarization.md), and legacy row 17 for the NLP capability service).
- **Summary / harness / trajectory routes on `ConsultationController` are documented elsewhere** — `:id/summary*` in [`summarization.md`](./summarization.md); `:id/harness-progress/stream`, `:id/harness-assurance/stream`, `:id/trajectory/stream`, and `:id/summary/:contextItemId/approve` in [`harness.md`](./harness.md). This file does not restate them.
- `TranscriptSegment` (`db_main/consultation.prisma`) is populated by the transcription pipeline, not the consultation service; it is recorded in [`transcription.md`](./transcription.md).

Last verified: 2026-07-22
