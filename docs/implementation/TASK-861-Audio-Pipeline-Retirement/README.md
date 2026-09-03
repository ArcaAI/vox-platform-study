# TASK-861 — Audio pipeline retirement: `AsrPipeline` → ASR Agent with gateway-resolved specs

| | |
|---|---|
| **Status** | Pending |
| **Type** | refactor (deprecation + replacement) |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/database`, `packages/domains`, `packages/applications` (`stt/*`, `pipeline-policy`, `tenant-stt-config`, `workflow-definition/compilers`), `apps/api` (`pipeline`, `streaming`, `stt-compat`, `pipeline-policy-admin`, `tenant-stt-config`, `internal`), `apps/stt`, `apps/admin-console` (`audio-pipelines`, `pipeline-policy`, `tenant-stt-config`, `transcription-jobs`, `playground-*`), `packages/workflow-contract` (stt palette), `packages/vox-node` (generated admin resource) |
| **Depends on** | TASK-860 (registry rows carry `localPath`/format), TASK-863 (the `Agent` entity that replaces the pipeline) |
| **Blocks** | TASK-865 (`pipelineId` removal in the SDK) |
| **Rules** | `02-database-prisma.md`, `03-domain-layer.md`, `04-application-services.md`, `05-nestjs-api.md`, `06-python-services.md`, `13-nextjs-apps.md` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> Following the model catalog by task, we built the agent for handling a single task. We have workflow for handling a chain of tasks. Retire all old audio pipelines. Remove all seed data. Deprecate logic code, data models, related unit tests and any tests. Retire the screen and related interfaces/screen components.

Restated:

1. The **`AsrPipeline` concept is retired**. Transcription is configured as an **ASR Agent** — one task (`automatic-speech-recognition`), one registered model, an audio front-end (VAD, denoise, diarization/speaker models chosen from the registry by task), language/decoding parameters, post-processing, and a declared fallback. Agents are defined by TASK-863; this ticket owns the migration of everything that today hangs off `AsrPipeline`.
2. `apps/stt` stops reading `AsrPipeline` and `AiModel` rows from Postgres. It receives a **fully resolved spec** per session/job from the gateway (the sanctioned "gateway-resolved injection" pattern, rule 06).
3. Every screen, route, service, domain trio, seed, SDK hook and test that exists only for `AsrPipeline`, `AsrPipelineVersion`, `TenantSttConfig`, `PipelinePolicy` and the `stt` workflow palette is **marked deprecated now and removed after two releases** (program policy, TASK-859 §6). "Deprecated" is a real state: the code still runs, carries a marker, emits no new rows, and is listed in the deprecation register with its removal release.
4. Batch transcription jobs (`TranscriptionJob`) stay: they are operational history, re-keyed to the agent version that ran them.

Classification: `refactor` across Database → Domain → Services → API → Python → Console → SDK.

## 2. Current State Evaluation

Verified 2026-09-04. Full inventory in §2.6; the load-bearing facts first.

### 2.1 `AsrPipeline` is the runtime execution artifact, not just an admin resource

| Fact | Evidence |
|---|---|
| `apps/stt` keeps a **read-only SQLAlchemy connection** and selects `AsrPipeline` by id/slug on every session and job start (`PipelineConfigReader.get_pipeline`, `get_pipeline_by_slug`); no cache, no fallback — a missing row raises `NotFoundError`. | `apps/stt/src/stt/core/database/{connection.py:1-60,models.py:169-172}`, `apps/stt/src/stt/pipeline/config_reader.py:36-133` |
| `apps/stt` also reads **`AiModel` by slug** (`get_model_reader().get_model_by_slug`) while building the ASR/VAD/denoise/embedding callables from the pipeline's YAML. | `apps/stt/src/stt/streaming/session_manager.py:1707-1853` |
| The pipeline id arrives in the streaming-session start body and is echoed on every transcript event. | `apps/stt/src/stt/streaming/schemas.py:161-214,325,417` |
| Gateway resolution order (three entry points): native `POST stream/session` requires `body.pipelineId`; batch `POST transcribe` falls back tenant `isDefault` → `TenantSttConfig.fallbackPipelineId` → 409; v1-compat `start_session` uses provider match → `isDefault` → `pipelines[0]`. | `apps/api/src/modules/streaming/transcription-job.controller.ts:245-294,391-401,595-720`, `apps/api/src/modules/stt-compat/stt-compat.controller.ts:118-206,368-384` |
| The WS URL never carries the pipeline id; it is bound at the REST session-create step, before the ticket is minted. | `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:150-190` |

### 2.2 The "transcription agent" already exists — as a workflow that compiles back into a pipeline

| Fact | Evidence |
|---|---|
| An `stt`-palette `WorkflowDefinition` (8 node types: `stt.audioInput → noiseFilter → vad → languageDetection → asrEngine → transcriptOutput`, plus `diarization`, `phiHop`) is seeded twice (SYSTEM template + ArcaAI copy). | `packages/database/src/prisma/db_main/seed/23a-realtime-transcription-agent.ts` (+ `.generated.ts`) |
| Publishing it does **not** create a new execution path: `compileSttGraphToYaml()` emits `AsrPipeline.configYaml` and writes it through `PipelineService` under the deterministic slug `wf-stt-<slug>`. | `packages/applications/src/services/workflow-definition/compilers/stt-pipeline.compiler.ts:1-70` |
| The Temporal activities for the eight `stt.*` nodes are **registry-parity placeholders** that return `DEGRADED` if ever dispatched. | `apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py:1-40` |
| `SttPipelineResolverService.resolvePipelineId(tenantId, slug)` exists but is **injected nowhere on the hot path**; a grep-gate test fails if `apps/api/src/modules/streaming/**` or `apps/stt/src/stt/streaming/**` is touched. | `packages/applications/src/services/workflow-definition/resolvers/stt-pipeline-resolver.service.ts`, `__tests__/task-724-stt-realtime-untouched.grep-gate.test.ts` |
| The console's Consultation Scribe still picks a raw `AsrPipeline` (`useAudioPipelines()` → `isDefault`) and passes `audio.start({ pipelineId })`; its footer merely *labels* it "Transcription Agent". | `apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx:201,267,453,637`, `scribe/scribe-footer.tsx:1-18` |

Conclusion: the workflow-based "agent" is a second authoring UI over the same table. Retiring `AsrPipeline` therefore means giving the ASR Agent its **own** resolution path into `apps/stt`, not wiring the unwired resolver.

### 2.3 Three neighbouring tables ride on `AsrPipeline`

| Table | Role today | Fate |
|---|---|---|
| `AsrPipelineVersion` | immutable snapshots of `configYaml` | retires with the parent; the Agent entity (TASK-863) has rows-are-versions |
| `TenantSttConfig` | one row per tenant: `fallbackPipelineId` (pointer, no FK), `autoSwitchEnabled`, `configJson`; SYSTEM row = platform default | retires; fallback + auto-switch become the ASR Agent's `fallback` block |
| `PipelinePolicy` / `PipelinePolicyChange` | polymorphic-scope toggles (`autoSummaryEnabled`, `autoNerEnabled`, `harnessEnabled`, `dnaStyleEnabled`, `dnaRedactionEnabled`), WORM change log; cascade DOCTOR → DEPARTMENT → TENANT → SYSTEM | **orthogonal to ASR** (gates downstream processing). Retires under this ticket because the target model expresses those toggles as `enabled` on workflow nodes, assigned per department through `WorkflowAssignment` (TASK-864). `PipelinePolicyScope` enum stays — `WorkflowAssignment` reuses it |
| `TranscriptionJob.pipelineId` | real FK to `AsrPipeline` | column deprecated; replaced by `agentVersionId` + a `resolvedSpec` snapshot |
| `Tenant.transcriptionMode` / `captureMode` | `LOCAL | BACKEND`, capture mode | `transcriptionMode` becomes meaningless once local transcription is gone (TASK-865); deprecate with the same window |

### 2.4 `apps/stt` model-resolution is already "resolved row in, path out"

`apps/stt` receives, per model, an `AiModelConfig` (`slug, source_uri, source_revision, local_path, checksum, device, compute_type, format, task_type, tenant_id`) and resolves it with `local_path` first, then scheme dispatch (`apps/stt/src/stt/models/source_resolver.py:88-121,288-334`). The catalogue-driven path is therefore **one step away** from gateway injection: today the `AiModelConfig` is built inside `apps/stt` from a DB read; tomorrow it arrives in the request. The processor registry maps `AiModelFormat` → engine (`asr_engines.py:23-37,345-359`) with eleven engine ids; VAD/denoise/diarization are string enums (`pipeline/dto.py:613,822-824`). None of this changes.

### 2.5 Loader gaps that the ASR Agent inherits (from the TASK-860 loader audit)

| Model | Verdict | Why |
|---|---|---|
| `nvidia/nemotron-3.5-asr-streaming-0.6b` via parakeet.cpp | **MISSING runtime** | no Python binding, no `libparakeet` build in `apps/stt/docker/Dockerfile`; `ParakeetCppLoader._resolve_binding` raises at load |
| DeepFilterNet3 | **MISSING dependency** | deliberately excluded (`numpy<2` pin); `deepfilternet_denoiser.py:71-74` degrades to a silent no-op |
| everything else in the ASR / VAD / denoise / speaker rows | READY | faster-whisper 1.2.1, pywhispercpp ≥1.5 (CUDA-built), transformers 5.5.4, onnxruntime, pyrnnoise, speechbrain, pyannote all declared and loading from a local dir/file |

These are TASK-860 deliverables; this ticket's acceptance for those two models is "fail closed with a clear error, never a silent no-op".

### 2.6 Full retirement footprint

**Schema** — `packages/database/src/prisma/db_main/`: `stt.prisma` (`AsrPipeline` :16-91, `AsrPipelineVersion` :96-119, `TranscriptionJob.pipelineId` :255-256), `pipeline-policy.prisma` (:26-98), `tenant-stt-config.prisma` (:24-58); enums `TranscriptionMode`, `CaptureMode` (`enums.prisma:410-426`); allow-lists `tenant-scope.ts:88-91,130-131,141,401,415`, `client.ts:104,113,222`; `ResourceType.{AsrPipeline,AsrPipelineVersion,TranscriptionJob,TenantSttConfig,PipelinePolicy,PipelinePolicyChange}`.

**Seeds** — `seed/06-stt.ts` (pipelines :979-1592, per-tenant mirrors :1198-1592, `backfillAsrPipelineDefault` :2068-2126, `seedTenantSttConfig` :2247-2262; the `AiModel` half of this file moves to TASK-860), `seed/14-pipeline-policy.ts`, `seed/23a-realtime-transcription-agent{,.generated}.ts`, regen script `packages/database/scripts/regen-realtime-transcription-agent-seed.ts`, seed tests `__tests__/task-858-realtime-transcription-agent.test.ts`, `task-821-realtime-lane-seeding.test.ts`, `managed-asr-addon-posture.test.ts`.

**Domain** — `packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/{AsrPipeline,AsrPipelineVersion,PipelinePolicy,PipelinePolicyChange,TenantSttConfig}*.ts` + `PipelinePolicyChangeRepository.encryption.ts`; `TranscriptionJob*` stays (column change only).

**Applications** — `services/stt/pipeline/**` (`PipelineService`, DTOs, `pipeline-template-resync.{service,cron.service}.ts`), `services/pipeline-policy/**`, `services/tenant-stt-config/**`, `services/settings-registry/descriptors/pipeline.descriptors.ts`, `workflow-definition/compilers/stt-pipeline.compiler.ts`, `workflow-definition/resolvers/stt-pipeline-resolver.service.ts`, `entitlements/*` (`maxAsrPipelines` at `entitlements.service.ts:211,545,619,666,738,791,822`, `entitlements-lifecycle.service.ts:250`), `user/userPreferences/userPreferences.service.ts:331-392` (per-user pipeline preference). `services/stt/{job,realtime,streaming}/**` stay and are re-keyed.

**API** — `modules/pipeline/audio-pipeline{,-catalog}.controller.ts`, `modules/pipeline-policy-admin/**`, `modules/tenant-stt-config/**`, the `pipelineId` branches of `modules/streaming/transcription-job.controller.ts` and `modules/stt-compat/stt-compat.controller.ts`, `modules/streaming/admin-transcription-job.controller.ts` (re-key), `modules/internal/stt-internal.controller.ts` (unchanged routes, new payload shape).

**Python** — `apps/stt/src/stt/core/database/{connection,models}.py` (`AsrPipelineRead`, `AiModelRead`), `pipeline/config_reader.py`, `pipeline/yaml_parser.py` (YAML → `PipelineSpec`), the DB-read half of `streaming/session_manager.py:1707-1853`, `models/registry_reader.py` (whatever `get_model_reader()` resolves to), tests `tests/unit/test_pipeline_dto*.py`, `tests/integration/test_database.py`.

**Workflow contract** — `packages/workflow-contract/src/node-registry.ts:354-500` (8 `stt.*` entries), `node-config-schemas.ts` (`STT_*_SCHEMA`), `node-ports.ts` (stt ports), `rule-catalogue.ts` (`WF-STT-001..006`), the `stt` palette in `node-registry.snapshot.json`; `apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py` + registry entries.

**Console** — `features/audio-pipelines/**`, `features/pipeline-policy/**`, `features/tenant-stt-config/**` (+ the STT tab of `/ai-configuration`), routes `/audio/pipelines`, `/harness/pipeline-policy`; re-keyed: `features/transcription-jobs/**`, `features/playground-live-transcription/**`, `features/playground-consultation/**` (`consultation-demo-screen.tsx`, `scribe/scribe-footer.tsx`), `features/account/components/account-screen.tsx:329`, `features/entitlements/**` (`maxAsrPipelines`); nav entries `nav-config.ts:695-702,753-763`.

**SDK** — `usePipelines`, `useArcaPipelines`, `AudioStartOptions.pipelineId`, compat `sttPipelineId` (TASK-865); `packages/vox-node/src/resources/admin/audio-pipeline.ts` (generated — regenerate).

**Tests** — e2e `apps/api/tests/e2e/{pipeline-clone-resync-cross-tenant,pipeline-template-governance,stt-fallback-cross-tenant,transcription-job-cross-tenant}.spec.ts`; unit tests colocated with every folder above; the grep-gate test.

## 3. Target Design

### 3.1 One resolution path

```
clinician / host app
   │  audio.start({ agentSlug? })          (TASK-865)
   ▼
POST /audio/transcription-jobs/stream/session   { agentSlug? , language? , deviceHints? }
   │  gateway: AsrAgentResolver
   │    1. explicit agentSlug  → must be a PUBLISHED, ACTIVE SPEECH_TO_TEXT agent visible to the tenant (404-over-403)
   │    2. else AgentAssignment cascade: department → tenant → SYSTEM default (TASK-863 §3.4)
   │    3. resolve every model reference on the agent → AiModelConfig (slug, format, localPath, computeType, sourceUri, checksum)
   │    4. resolve cloud credentials (if the ASR model is a cloud row) → provider_overrides (unchanged mechanism)
   │    5. produce ResolvedAsrSpec (schemaVersion, agentVersionId, models{asr,vad?,denoise?,diarization?,embedding?}, language, decoding, postProcessing, fallback)
   ▼
apps/stt   POST /streaming/sessions  { spec: ResolvedAsrSpec, provider_overrides }     ← no DB read
   │  session_manager builds callables from spec.models[*] exactly as _load_asr_pipeline does today,
   │  minus get_model_reader().get_model_by_slug
   ▼
Redis Streams ⇄ SttWsGateway ⇄ WS client   (unchanged)
```

Batch: `POST /audio/transcription-jobs/transcribe { agentSlug?, mediaId }` → the same resolver → `TranscriptionJob{ agentVersionId, resolvedSpec }` → Dramatiq payload carries `resolvedSpec`. The job is reproducible from its own row.

`ResolvedAsrSpec` is a versioned JSON contract owned by `packages/types` (TS) and mirrored as a pydantic model in `apps/stt` (`PipelineSpec` today; renamed, YAML parser removed). The parity test that pins `AiModelFormat` ↔ Python enum today (`stt/pipeline/dto.py`) extends to this contract.

### 3.2 What the ASR Agent carries (config schema owned by TASK-863; listed here because it replaces `configYaml`)

| Block | Fields | Replaces |
|---|---|---|
| `model` | `modelSlug` (registry row, `taskType = AUTOMATIC_SPEECH_RECOGNITION`); compute type / format come from the row | `models.asr` |
| `audioFrontEnd` | `vad: { modelSlug?, threshold, minSpeechMs, minSilenceMs }`, `denoise: { modelSlug?, level }`, `diarization: { enabled, backend: embedding|sortformer, embeddingModelSlug?, maxSpeakers }`, `resample`, `normalize` | `models.vad`, `models.denoise`, `models.embedding`, `preprocessing.*` |
| `decoding` | `languageMode` (`en|ml|ml-en|vi|vi-en|auto`, mirrors `apps/stt/src/stt/pipeline/language_modes.py`), `codeSwitching`, `initialPrompt`/hotwords, `wordTimestamps`, `beamSize`, `temperature`, `vadFilter` | `inference.*` |
| `postProcessing` | `punctuation: { modelSlug? }` (Cadence — served by `apps/stt`, see TASK-860 §catalogue corrections), `disfluency`, `stabilizer`, `merge` | `postprocessing.*` |
| `streaming` | `partialIntervalMs`, `endpointing: fixed|semantic`, `maxUtteranceSec` | streaming knobs |
| `fallback` | `agentSlug?`, `autoSwitch: boolean`, `switchAfterConsecutiveFailures` | `TenantSttConfig.fallbackPipelineId`, `autoSwitchEnabled` |

Every `*Slug` is a **reference** resolved through the registry; the agent never carries an engine name, an endpoint or a credential (the `FORBIDDEN_CONFIG_KEYS` rule of `agentic-contract.ts` applies to agents too).

### 3.3 Deprecation mechanics (mark now, remove in release +2)

| Layer | Marker |
|---|---|
| Prisma | `/// @deprecated TASK-861 — removed in <release>` doc comment on each model; no new columns; `TranscriptionJob.pipelineId` made nullable (migration `task_861_transcription_job_agent_version`) |
| Domain / applications | `@deprecated` JSDoc on every exported symbol; services keep working but `create`/`clone` on `PipelineService` return `410 Gone` semantics via `GoneException` **after** the console stops calling them (step 9) |
| API | routes keep responding for reads; write routes carry `@ApiDeprecated()` + `Deprecation`/`Sunset` headers (RFC 8594) with the removal date; OpenAPI tag description says so |
| Console | routes replaced by `redirect()` stubs with the standard one-release comment (`13-nextjs-apps.md` §Routing) |
| Python | `PipelineConfigReader` raises `DeprecationWarning` on use; the session-start endpoint accepts both `pipeline_id` and `spec` for one release, then `spec` only |
| SDK | TASK-865 |
| Seeds | removed immediately (no production data — `pre-production-build-for-day-one`) |
| Register | one row per item in `docs/operations/deprecation-register.md` |

## 4. Implementation Plan

Layer order: Database → Domain → Services → API → Python → Console → SDK. TDD; each step names its RED test.

| # | Step | RED test | Files |
|---|---|---|---|
| 1 | `ResolvedAsrSpec` contract (TS type + JSON schema + Python pydantic mirror) with a cross-language parity test on a committed fixture | `tests/contracts/resolved-asr-spec-parity.contract.test.ts`, `apps/stt/tests/unit/test_resolved_spec_parity.py` | `packages/types/src/asr-spec.ts`, `apps/stt/src/stt/pipeline/spec.py` |
| 2 | Migration: `TranscriptionJob.agentVersionId String?`, `resolvedSpec Json?`, `pipelineId` nullable; `@deprecated` doc comments on the four models; shadow-DB proof | migration SQL reviewed; `pnpm --filter @arcaai/database test` | `packages/database/src/prisma/db_main/stt.prisma`, `migrations/<ts>_task_861_…` |
| 3 | `AsrAgentResolver` in `packages/applications/src/services/stt/agent-resolver/` — explicit slug → assignment cascade → model resolution → spec; 404-over-403; fail-closed on an unresolvable model | `asr-agent-resolver.service.test.ts` (explicit, cascade, foreign slug 404, unresolved model throws) | new service folder; depends on TASK-863 `AgentRepository` |
| 4 | Gateway: stream-session create + batch transcribe + v1-compat `start_session` call the resolver; `pipelineId` accepted with a `Deprecation` header for one release | controller tests extended; e2e `stt-agent-session.spec.ts` | `modules/streaming/transcription-job.controller.ts`, `modules/stt-compat/stt-compat.controller.ts` |
| 5 | Delete the grep-gate test with a recorded exception in this README (it exists to protect the path this ticket changes) | — | `workflow-definition/__tests__/task-724-stt-realtime-untouched.grep-gate.test.ts` |
| 6 | `apps/stt`: session-start and batch payloads accept `spec`; `session_manager` builds callables from `spec.models` (no `get_model_by_slug`); `PipelineConfigReader` deprecated; DB connection becomes optional and OFF by default | `tests/unit/streaming/test_session_from_spec.py`, `test_no_db_read_on_session_start.py` | `apps/stt/src/stt/streaming/{schemas,session_manager}.py`, `pipeline/config_reader.py`, `core/database/*` |
| 7 | `apps/stt`: parakeet.cpp and DeepFilterNet3 selections **fail closed** with a named error until TASK-860 ships their runtimes (no silent no-op) | `test_denoiser_fails_closed_without_df.py`, `test_parakeet_fails_closed.py` | `streaming/deepfilternet_denoiser.py`, `models/parakeet_cpp_loader.py` |
| 8 | Fallback/auto-switch re-implemented on the resolver from `agent.fallback` (same behaviour as `TenantSttConfig`); `TenantSttConfigService` deprecated | `asr-agent-resolver.fallback.test.ts`; existing `stt-ws.gateway` switch tests re-pointed | `stt/agent-resolver`, `modules/streaming/stt-ws.gateway.ts` |
| 9 | Console: `/audio/pipelines` and `/harness/pipeline-policy` → `redirect()` stubs; `/ai-configuration` loses the STT fallback tab; Consultation Scribe, Live Transcription playground, Account screen use `agentSlug`/`useSelectableAsrAgents`; entitlements panel drops `maxAsrPipelines` | `retired-route-redirects.test.tsx` extended; feature tests updated | `apps/admin-console/src/app/(console)/(tenant)/{audio,harness}/**`, `features/**` listed in §2.6 |
| 10 | Workflow contract: `stt` palette entries `implemented: false` + `deprecated: true` (new descriptor flag), rules `WF-STT-*` retired, snapshot regenerated, Python placeholders removed; `EXPOSURE_ALLOWED_PALETTES` unchanged | `node-registry-parity.test.ts`, `registry.py` parity | `packages/workflow-contract/src/*`, `apps/harness/.../interpreter/{registry.py,nodes/stt_placeholder.py}` |
| 11 | Seeds: delete pipelines from `06-stt.ts`, delete `14-pipeline-policy.ts`, `23a-*`, regen script and their seed tests; `06-stt.ts` keeps only the `AiModel` seeding until TASK-860 moves it | seed suite green; `pnpm db:all` on a fresh local DB | `packages/database/src/prisma/db_main/seed/**` |
| 12 | Entitlements: `maxAsrPipelines` → deprecated alias of `maxAgents` (TASK-863 decides the final key) | entitlements tests | `services/entitlements/**` |
| 13 | API artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`; the generated `hope.admin.audioPipeline.*` carries the deprecation | `api:openapi:check`, `gen:admin:check` | — |
| 14 | Deprecation register rows + rule updates (`06-python-services.md` "STT reads no DB", `08-vox-sdk.md`) | — | docs |

### Verification criteria

- `pnpm --filter @arcaai/domains test`, `pnpm --filter @arcaai/applications test`, `pnpm test:unit`, `pnpm stt:test` green; `pnpm api:build`, `pnpm --filter @arcaai/admin-console build lint test` green.
- e2e: `npx dotenv -e .env.test -- npx playwright test stt-agent-session transcription-job-cross-tenant` green; the retired pipeline e2e specs deleted with the code they covered.
- Live proof on dev: open the Consultation Scribe, start capture with no slug (cascade default) and with an explicit slug; transcript renders; `apps/stt` logs show **no** `AsrPipeline`/`AiModel` SQL on session start.
- Batch: upload a file → job row carries `agentVersionId` + `resolvedSpec`; worker completes from the payload alone.

## 5. Decisions taken in this ticket (owner may override)

| # | Decision | Alternative rejected |
|---|---|---|
| D-1 | `apps/stt` becomes DB-free for selection (gateway-resolved spec). | Keep `AsrPipeline` as an internal "compiled artifact" table that stt reads — keeps a second source of truth and the DB connection rule 06 discourages. |
| D-2 | `PipelinePolicy` retires with the pipelines; its five toggles become node `enabled` flags on the assigned workflow. | Keep it as an orthogonal cascade — two places to express "run NER for this department". |
| D-3 | v1-compat STT routes stay, resolve via the agent resolver, and accept `pipelineId` for one release with a `Deprecation` header. | Freeze v1-compat on `AsrPipeline` forever — would block the table drop. |
| D-4 | The realtime "Transcription Agent" is an **Agent row** (TASK-863), not an `stt`-palette workflow; the palette retires. | Keep the STT palette as the ASR authoring UI — it compiles to a table we are removing, and its Temporal nodes are placeholders. |
| D-5 | Seeded pipelines are not migrated; the SYSTEM default ASR agent + a Global-tenant example set are seeded by TASK-863. | One-time backfill of ~15 rows per tenant — no production data exists. |

## 6. Open questions for the owner

1. Removal release: which two tags bound the deprecation window (the register needs concrete `<SVC>-x.y.z` values)?
2. `Tenant.transcriptionMode` / `captureMode`: retire with this ticket (recommended, TASK-865 makes LOCAL impossible) or keep `captureMode`?
3. Should `TranscriptionJob` history rows that reference a retired pipeline be kept read-only (recommended) or purged before the drop?

## 7. Implementation Summary

_Pending._

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review: retirement footprint, target resolution path, plan. |
