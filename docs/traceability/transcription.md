# Traceability — Transcription (live, batch, recordings, voice profiles, pipelines)

Speech-to-text across all its shapes: live streaming transcription (WS bridge → Redis →
STT), batch transcription jobs (Dramatiq worker), speaker voice-profile enrollment +
diarization, and the ASR pipeline registry with its TASK-531 template governance (locked
template copies, clone-to-customize, SYSTEM-template resync). Migrates legacy matrix rows
**10**, **11**, **13**, and the **ASR-pipeline half of row 26** (the `AiModel` registry
half is in [`ai-models-providers.md`](./ai-models-providers.md)).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture: browsers never call `apps/stt` directly. Live audio bridges through the
gateway WS gateway into a Redis-Streams session that STT consumes; batch audio uploads
create a `TranscriptionJob` the Dramatiq worker processes, with progress/results posted
back to the gateway on internal service-token callbacks.

## Capabilities

### R1 — Live transcription (streaming STT) — legacy row 10

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt` (port 8861) + Redis |
| Key modules | `apps/api/src/modules/streaming` (`stt-ws.gateway.ts`, `transcription-job.controller.ts` stream-session routes, `session-removal-retry.service.ts`); `packages/applications/src/services/stt/streaming` (`streamingSession.service.ts`, `streamingAudioBridge.service.ts`), `packages/applications/src/services/stt/realtime`; `apps/stt/src/stt/streaming` |
| Prisma models | `TranscriptionJob`, `AsrPipeline` (`db_main/stt.prisma`), `TranscriptSegment` (`db_main/consultation.prisma`) |
| Key API endpoints | `POST /audio/transcription-jobs/stream/session` (open session + ticket), `DELETE /audio/transcription-jobs/stream/session/:sessionId`, `POST /audio/transcription-jobs/stream/session/:sessionId/refresh-ticket`; WS gateway `@WebSocketGateway({ path: '/ws/stt/stream' })` → WS `/ws/stt/stream`; STT internal (`streaming/api/routes.py`, `APIRouter(prefix="/internal/streaming")`) → `POST /internal/streaming/sessions`, `GET /internal/streaming/sessions/active`, `GET/DELETE /internal/streaming/sessions/:session_id`, `POST /internal/streaming/sessions/:session_id/end` |
| Console | `apps/admin-console` feature `playground-live-transcription` (`live-transcription-screen`, `streaming-tab`); route `/playground/live-transcription` (tier 50–59 playground, nav-gated under `(tenant)`) |
| Tests | unit(app): `stt/streaming/__tests__/{streamingSession.service,streamingAudioBridge.service,speaker-label}.test.ts`; unit(console): `playground-live-transcription/components/__tests__/{live-transcription-screen,streaming-tab}.test.tsx`, `playground-live-transcription/api/__tests__/{use-live-stt-session.test.tsx,live-transcription-api.test.ts}`; contract: `stt.contract.test.ts` (+ `tests/contracts/stt-transcript-segments/`); e2e: `transcription-job-cross-tenant.spec.ts`; py(stt): `unit/streaming/*` |

### R2 — Batch transcription jobs — legacy row 11

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt` (Dramatiq worker `worker.py`) |
| Key modules | `apps/api/src/modules/streaming` (`transcription-job.controller.ts`, `admin-transcription-job.controller.ts`); `apps/api/src/modules/internal` (`stt-internal.controller.ts` — job callbacks); `packages/applications/src/services/stt/job`; `apps/stt/src/stt/transcription` |
| Prisma models | `TranscriptionJob` (`db_main/stt.prisma`), `Media` (`db_main/media.prisma`) |
| Key API endpoints | `@Controller('audio/transcription-jobs')`: `POST ''`, `POST /batch`, `POST /streaming`, `POST /transcribe`, `GET /stats`, `GET /status/:status`, `GET /consultation/:consultationId`, `GET :id`, SSE `GET :id/stream`, `POST :id/cancel`, `POST :id/retry`, `GET ''` (list). `@Controller('admin/audio/transcription-jobs')`: `GET ''`, `GET /stats`, `GET /status/:status`. STT `POST /api/v1/transcribe`; internal callbacks `@Controller('internal/stt')` → `POST /internal/stt/transcripts`, `PATCH /internal/stt/jobs/:id/{start,progress,complete,fail}`, `GET /internal/stt/jobs/:id/status` |
| Console | `apps/admin-console` feature `transcription-jobs` (`transcription-jobs-screen`); route `/audio/transcription-jobs` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `stt/job/__tests__/{transcriptionJob.service,transcriptionJob.service.encryption}.test.ts`; unit(console): `transcription-jobs/components/__tests__/transcription-jobs-screen.test.tsx`, `transcription-jobs/api/__tests__/transcription-jobs-api.test.ts`; py(stt): `unit/test_batch_service.py`, `unit/test_broker.py`, `unit/test_job_concurrency.py`, `integration/*` |

### R3 — Voice profiles / speaker enrollment — legacy row 13

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt` + Qdrant (embedding store) |
| Key modules | `apps/api/src/modules/voice-profile` (`voice-profile.controller.ts`); `apps/stt/src/stt/voice_profile`, `apps/stt/src/stt/diarization`, `apps/stt/src/stt/embedding` |
| Prisma models | `UserVoiceProfile` (`db_main/user.prisma`) |
| Key API endpoints | `@Controller('voice-profile')`: `POST /voice-profile/enroll`, `GET /voice-profile`, `PATCH /voice-profile/:id/activate`, `PATCH /voice-profile/:id/deactivate`, `DELETE /voice-profile/:id`; STT internal (`voice_profile/api/routes.py`, `APIRouter(prefix="/internal/voice-profile")`) → `POST /internal/voice-profile/extract` |
| Console | `apps/admin-console` feature `playground-voice-profiles` (`voice-profiles-screen`); route `/playground/voice-profiles` (tier 50–59 playground) |
| Tests | unit(api): `voice-profile/__tests__/voice-profile.controller.test.ts`; unit(console): `playground-voice-profiles/components/__tests__/voice-profiles-screen.test.tsx`, `playground-voice-profiles/api/__tests__/voice-profiles-api.test.ts`; e2e: `voice-profile-cross-tenant.spec.ts`; py(stt): `unit/test_diarization.py`, `unit/diarization/*` |

### R4 — ASR pipeline registry (public read + admin CRUD) — legacy row 26 (ASR part)

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt` (reads the effective pipeline config) |
| Key modules | `apps/api/src/modules/pipeline` (`audio-pipeline.controller.ts`, `audio-pipeline-public.controller.ts`); `packages/applications/src/services/stt/pipeline` (`pipeline.service.ts`, `pipeline.dto.mapper.ts`) |
| Prisma models | `AsrPipeline`, `AsrPipelineVersion` (`db_main/stt.prisma`) |
| Key API endpoints | `@Controller('audio/pipelines')` (public read): `GET ''`, `GET :id`, `GET /slug/:slug`. `@Controller('admin/audio/pipelines')` (via `@ApiEndpoint`): `POST ''`, `GET ''`, `GET /list`, `GET :id`, `GET /slug/:slug`, `PATCH :id` (`@RequiresIfMatch()` OCC — 412/428), `DELETE :id`, `POST /validate`, `POST :id/assign-tenant`, `POST :id/set-default`, `PATCH :id/toggle`, `GET :id/versions`, `GET :id/versions/:versionNumber` |
| Console | `apps/admin-console` feature `audio-pipelines` (`audio-pipelines-screen`); route `/audio/pipelines` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `stt/pipeline/__tests__/{pipeline.service,pipeline.service.task328}.test.ts`; unit(api): `pipeline/__tests__/{audio-pipeline.controller,audio-pipeline-public.controller}.test.ts`; unit(console): `audio-pipelines/components/__tests__/audio-pipelines-screen.test.tsx`, `audio-pipelines/api/__tests__/audio-pipelines-api.test.ts`; py(stt): `unit/test_config_reader.py` |

### R5 — Pipeline template governance: clone + SYSTEM-template resync (TASK-531) — NEW (post-2026-07-06)

Locked SYSTEM-template copies are read-only; a tenant admin **clones** one into an editable
copy (carrying template provenance), and a global admin **resyncs** a tenant's catalog
against the SYSTEM templates (missing templates cloned in as locked copies; pristine locked
copies fast-forwarded; customized/unlocked rows never touched).

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/pipeline` (`audio-pipeline.controller.ts` `:id/clone`); `apps/api/src/modules/tenant` (`tenant-pipeline-resync.controller.ts`); `packages/applications/src/services/stt/pipeline` (`pipeline.service.ts` clone, `pipeline-template-resync.service.ts`, `pipeline-template-resync.cron.service.ts` — nightly sweep OFF by default) |
| Prisma models | `AsrPipeline` (`templateLocked`, `sourceTemplateSlug` provenance), `AsrPipelineVersion` (fast-forward writes a new version snapshot) |
| Key API endpoints | `POST /admin/audio/pipelines/:id/clone` (unlock into an editable copy); `POST /admin/tenants/:id/pipelines/resync` (`@CanManage('Tenant')`, `@HttpCode(200)`, returns `{ added, fastForwarded, skipped }`; SYSTEM tenant cannot resync against itself → 400) |
| Console | `apps/admin-console` feature `audio-pipelines` template-governance surface (`template-governance`) under route `/audio/pipelines` |
| Tests | unit(app): `stt/pipeline/__tests__/{pipeline.service.task531,pipeline-template-resync.service,pipeline-template-resync.cron.service}.test.ts`; unit(api): `pipeline/__tests__/audio-pipeline.task531.controller.test.ts`; unit(console): `audio-pipelines/components/__tests__/template-governance.test.tsx`; e2e: `pipeline-clone-resync-cross-tenant.spec.ts`, `pipeline-template-governance.spec.ts` |

## Honest notes / gaps

- **The `AiModel` half of legacy row 26 is NOT here.** The model registry / discovery / task-defaults live in [`ai-models-providers.md`](./ai-models-providers.md); only `AsrPipeline`/`AsrPipelineVersion` and `modules/pipeline` are recorded in this domain.
- **`TranscriptSegment` (`db_main/consultation.prisma`) is a transcription-owned model on the consultation schema file.** It is populated by the streaming/batch path here, not by the consultation service.
- **Nightly resync is off by default.** The `PipelineTemplateResyncCronService` sweep is disabled so a human stays in the loop; `POST /admin/tenants/:id/pipelines/resync` is the primary (admin-triggered) path.
- **No dedicated live-DB streaming e2e for the WS bridge.** R1 has unit + contract + cross-tenant-job coverage; the full browser-WS live-transcription round-trip is env-gated (playground manual pass), not an `apps/api/tests/e2e` spec.

Last verified: 2026-07-22
