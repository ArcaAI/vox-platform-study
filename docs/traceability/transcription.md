# Traceability — Transcription (live, batch, recordings, voice profiles, pipelines)

Speech-to-text across all its shapes: live streaming transcription (WS bridge → Redis →
STT), batch transcription jobs (Dramatiq worker), speaker voice-profile enrollment +
diarization. Migrates legacy matrix rows **10**, **11**, **13**, and the
**ASR-pipeline half of row 26** (the `AiModel` registry half is in
[`ai-models-providers.md`](./ai-models-providers.md)) — that ASR-pipeline half (R4-R6
below) was itself RETIRED by TASK-1006 (2026-09-25): the pipeline registry, its
template-clone/resync governance, and the per-tenant STT fallback/BYOK config all moved
onto the agent/workflow plane. `agentSlug` selects a published `SPEECH_TO_TEXT` `Agent`
(department → tenant → SYSTEM cascade when omitted), whose own `AgentModelFallback` chain
is what a session or batch job now falls back to — see
[model-and-config-plane.md §8](../architecture/model-and-config-plane.md#8-asr-selection--fallback--removed-the-pipeline-template-plane-task-1006).

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
| Prisma models | `TranscriptionJob` (`db_main/stt.prisma`), `TranscriptSegment` (`db_main/consultation.prisma`) |
| Key API endpoints | `POST /audio/transcription-jobs/stream/session` (open session + ticket), `DELETE /audio/transcription-jobs/stream/session/:sessionId`, `POST /audio/transcription-jobs/stream/session/:sessionId/refresh-ticket`; WS gateway `@WebSocketGateway({ path: '/ws/stt/stream' })` → WS `/ws/stt/stream`; STT internal (`streaming/api/routes.py`, `APIRouter(prefix="/internal/streaming")`) → `POST /internal/streaming/sessions`, `GET /internal/streaming/sessions/active`, `GET/DELETE /internal/streaming/sessions/:session_id`, `POST /internal/streaming/sessions/:session_id/end` |
| Console | `apps/admin-console` feature `playground-live-transcription` (`live-transcription-screen`, `streaming-tab`); route `/playground/live-transcription` (tier 50–59 playground, nav-gated under `(tenant)`) |
| Tests | unit(app): `stt/streaming/__tests__/{streamingSession.service,streamingAudioBridge.service,speaker-label}.test.ts`; unit(console): `playground-live-transcription/components/__tests__/{live-transcription-screen,streaming-tab}.test.tsx`, `playground-live-transcription/api/__tests__/{use-live-stt-session.test.tsx,live-transcription-api.test.ts}`; contract: `stt.contract.test.ts` (+ `tests/contracts/stt-transcript-segments/`); e2e: `transcription-job-cross-tenant.spec.ts`; py(stt): `unit/streaming/*` |

### R2 — Batch transcription jobs — legacy row 11

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/stt` (Dramatiq worker `worker.py`) |
| Key modules | `apps/api/src/modules/streaming` (`transcription-job.controller.ts`, `admin-transcription-job.controller.ts`); `apps/api/src/modules/internal` (`stt-internal.controller.ts` — job callbacks); `packages/applications/src/services/stt/job`; `apps/stt/src/stt/transcription` |
| Prisma models | `TranscriptionJob` (`db_main/stt.prisma`), `Media` (`db_main/media.prisma`) |
| Key API endpoints | `@Controller('audio/transcription-jobs')`: `POST ''`, `POST /batch`, `POST /streaming`, `POST /transcribe`, `GET /stats`, `GET /status/:status`, `GET /consultation/:consultationId`, `GET :id`, SSE `GET :id/stream`, `POST :id/cancel`, `POST :id/retry`, `GET ''` (list). `@Controller('admin/audio/transcription-jobs')`: `GET ''`, `GET /stats`, `GET /status/:status`. Internal callbacks `@Controller('internal/stt')` → `POST /internal/stt/transcripts`, `PATCH /internal/stt/jobs/:id/{start,progress,complete,fail}`, `GET /internal/stt/jobs/:id/status`. (STT's own `POST /api/v1/transcribe` and `POST /api/v1/pipelines/validate` were removed by TASK-1006 along with the optional STT database layer.) |
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

### R4/R5/R6 — ASR pipeline registry, template governance, tenant STT fallback/BYOK — RETIRED (TASK-1006)

These three capabilities — the `AsrPipeline` public/admin registry (legacy row 26 ASR
half), its SYSTEM-template clone/resync governance, and per-tenant STT fallback +
BYOK/in-session provider switch via `TenantSttConfig` — were removed outright on
2026-09-25. Gone: `apps/api/src/modules/pipeline/**`, `apps/api/src/modules/tenant/
tenant-pipeline-resync.controller.ts`, `apps/api/src/modules/tenant-stt-config/**`, the
`audio/pipelines` + `admin/audio/pipelines` + `admin/stt-config` + `admin/tenants/:id/
pipelines/resync` routes, and the console's `audio-pipelines`/`tenant-stt-config`
features (the latter never shipped past its `⚠️ DESIGN GATE OPEN` state). STT's own
`pipeline_id`/`fallback_pipeline_id` readers and its optional read-only Postgres
connection are gone too (`apps/stt` reads no database).

**Replacement:** a published `SPEECH_TO_TEXT` `Agent` (+ its own `AgentModelFallback`
chain) is the only unit of ASR configuration now — content, not a per-tenant config row.
`agentSlug` is the sole client-facing selector (omit it and `AgentAssignment` resolves
department → tenant → SYSTEM); `AsrAgentResolverService` resolves the winning agent into
a `ResolvedAsrSpec` the gateway hands `apps/stt` at session-create/batch-dispatch time.
The `switch-to-fallback` mechanism (`SessionManager`'s `EngineSwitchController`, one-way
auto / bidirectional manual) still exists and still publishes `status`/`provider_switched`
over `stt:result:{sessionId}` — it just now switches to the resolved agent's own fallback
engine instead of a client- or config-row-supplied pipeline id, and
`POST audio/transcription-jobs/stream/session/:sessionId/switch-to-fallback` trusts the
runtime (409 when the session has none) rather than pre-checking a `TenantSttConfig` row.
BYOK is unchanged in kind, moved store: `AiProviderConnection` (`service='stt'`) instead
of `TenantSttProviderCredential`; `GET /internal/stt/provider-overrides` is still the
batch-worker credential pull, just resolved from the new store.

`AsrPipeline`/`AsrPipelineVersion` and `TenantSttConfig` remain in the schema pending a
drop migration (TASK-1006 wave 2, D-1) once every reader is confirmed gone; see
[model-and-config-plane.md §8](../architecture/model-and-config-plane.md#8-asr-selection--fallback--removed-the-pipeline-template-plane-task-1006).
Every test file this section used to cite for R4/R5/R6 (`pipeline/__tests__/**`,
`tenant-stt-config/__tests__/**`, `stt/pipeline/__tests__/**`, the console
`audio-pipelines`/`tenant-stt-config` suites, `stt-fallback-cross-tenant.spec.ts`) was
deleted with its subject; the `apps/stt` fallback-engine unit suites
(`test_engine_switch.py`, `test_transcribe_file_fallback_task567.py`) survive, now
exercising the agent-resolved fallback chain instead of a client-supplied pipeline id.

## Honest notes / gaps

- **The `AiModel` half of legacy row 26 is NOT here.** The model registry / discovery / task-defaults live in [`ai-models-providers.md`](./ai-models-providers.md); the `AsrPipeline`/`AsrPipelineVersion`/`modules/pipeline` half that used to be recorded in this domain retired with R4/R5/R6 above (TASK-1006).
- **`TranscriptSegment` (`db_main/consultation.prisma`) is a transcription-owned model on the consultation schema file.** It is populated by the streaming/batch path here, not by the consultation service.
- **No dedicated live-DB streaming e2e for the WS bridge.** R1 has unit + contract + cross-tenant-job coverage; the full browser-WS live-transcription round-trip is env-gated (playground manual pass), not an `apps/api/tests/e2e` spec.
- **R6 discovered a real drift, not yet fixed here (Phase H is docs-only)**: a seed change added `openai` to `packages/database/src/prisma/db_main/seed/ai-models/shared.ts`'s `AI_MODEL_PROVIDERS` without the matching addition to the DTO allow-list `AI_MODEL_PROVIDERS` in `packages/applications/src/services/stt/model/dto/create-model.request.ts` — `tests/contracts/ai-model-providers.contract.test.ts` fails as a result (`@IsIn` on the admin `AiModel` create/update routes would reject `provider: 'openai'` today). Confirmed via `git stash` bisection that this is caused by that seed change (the contract test passes on the tree before it), not pre-existing drift.

Last verified: 2026-07-22 (R4/R5/R6 updated 2026-09-25 for TASK-1006's removal of the pipeline stack — the rest of this file was not re-verified in that pass)
