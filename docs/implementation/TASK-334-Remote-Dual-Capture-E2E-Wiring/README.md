# TASK-334 — Remote Dual-Capture: End-to-End Wiring

| | |
|---|---|
| **Ticket** | TASK-334 |
| **Parent** | TASK-333 (Audio Dual-Capture: Remote) / TASK-331 doc-06 (F2) |
| **Created** | 2026-06-05 |
| **Updated** | 2026-06-05 |
| **Status** | Completed |

> Spun out of the TASK-333 merge review. TASK-333 landed the **scaffolding** for remote per-pipeline dual-capture (YAML parsing, gateway forwarding, `_finalize_session` registration, the admin editor, and the typed `stt.transcriptionPipelineId` field). This ticket makes it **actually work end-to-end**. Until it lands, **TASK-333 AC#2 and AC#4 are NOT met E2E**.

---

## 1. Requirement Analysis

### Description
When a tenant admin enables `dual_capture` on a remote ASR pipeline, the raw/processed audio that the streaming path already uploads to object storage must be **registered as `Media` + `AudioRecording` rows and attached to the consultation as a context item**, and the in-consultation recorder must actually **run on that pipeline** (not the hardcoded `turbo`).

### Why it's not done in TASK-333
TASK-333 was scoped to the parts that were self-contained and safe to merge. The two remaining gaps cross the Python↔NestJS contract boundary and the SDK config-population path, which need their own design + tests.

### Acceptance criteria
- [x] **I-2a — Route contract:** `stt-v2` `gateway.create_audio_recording` posts to the **correct** internal NestJS route (was `/audio-recordings`; controller is `/audio-records`). Aligned + covered by a contract test.
- [x] **I-2b — Media registration endpoint:** an internal endpoint exists to register a storage object as a `Media` row (`POST /internal/stt/media`), returning the `mediaId` used for `rawMediaId`/`processedMediaId`.
- [x] **I-2c — Context attachment:** the streaming path resolves `consultationId → contextItem` container so the `AudioRecording` is attached to the consultation (matching the local path's `AUDIO_RECORDING` attachment).
- [x] **I-1 — Pipeline-id population:** the resolved remote pipeline id is surfaced into `resolvedConfig.stt.transcriptionPipelineId` from the tenant/user remote-config cascade (admin-owned), so the consultation panel runs the correct pipeline. (Schema field + typed read landed in TASK-333 `95b77524`.)
- [x] End-to-end (reasoned + unit-covered): enabling `dual_capture` on the user's resolved pipeline produces `Media` + `AudioRecording` rows (both ids) attached to the consultation; disabling produces none.
- [x] Tests green (pytest contract + vitest), no regressions.

---

## 2. Current State (entry point for the implementer)

| Gap | Where | Note |
|---|---|---|
| Route name mismatch | `apps/stt-v2/src/stt_v2/core/api_client/gateway.py` → NestJS `apps/api/.../stt` internal controller | Client posts `/audio-recordings`; controller route is `/audio-records`. |
| No `Media` registration endpoint | `apps/api` internal STT module; `packages/applications/.../stt/internal` | `sttInternal.createAudioRecord` accepts `rawMediaId`/`processedMediaId`, but there is no endpoint to first turn a storage key into a `Media` row. |
| No consultation→context resolution | `apps/stt-v2/.../streaming/session_manager.py:_finalize_session` + internal STT service | Need `consultationId → contextItem` container lookup so the recording attaches (parity with TASK-332 local path). |
| Pipeline-id not populated | SDK config cascade → `AgenticProvider` / tenant-config resolver | `stt.transcriptionPipelineId` exists in `SttConfigSchema` but nothing writes it; panel falls back to `DEFAULT_TRANSCRIPTION_PIPELINE_ID` (`turbo`). |

### Already in place (reuse — do not rebuild)

_Re-audit 2026-06-05: the codebase drifted **favorably** since this ticket was opened — the Python orchestration is complete; the remaining gaps are entirely on the NestJS receiving end + the SDK cascade wiring._

- **Python orchestration is complete.** `session_manager._register_dual_capture` (`apps/stt-v2/src/stt_v2/streaming/session_manager.py:1551`) already, when `dual_capture` is enabled: uploads raw/processed WAVs to object storage → calls `gateway.create_media(...)` for each → calls `gateway.create_audio_recording(consultation_id, raw_media_id, processed_media_id, ...)`. Best-effort, never blocks finalization.
- `gateway.create_media(...)` **exists** and posts `POST /internal/stt/media` (`gateway.py:357`); `gateway.create_audio_recording(...)` forwards `raw_media_id`/`processed_media_id`/`consultation_id` (`gateway.py:293`).
- `sttInternal.createAudioRecord` (TS) accepts `rawMediaId`/`processedMediaId` (`packages/applications/src/services/stt/internal/sttInternal.service.ts:196`) and creates a `Media` from `storagePath` internally.
- **Local-path parity helper exists:** `ContextService.findOrCreateAudioContainer(consultationId, tenantId, userId)` (`packages/applications/src/services/consultation/context/context.service.ts:983`) is exactly the `consultationId → AUDIO_RECORDING contextItem` resolution the remote path needs (I-2c reuses it).
- **I-1 data source already resolved server-side:** `GET /user/me/preferences` returns `remoteConfig.pipelineId`, computed by `UserPreferencesService.resolveRemoteConfig()` with 3-tier precedence (per-user admin `assigned-pipeline` → tenant `AsrPipeline.isDefault` → global `default-stt-pipeline`). No new GlobalSetting key needed.
- `SttConfigSchema.transcriptionPipelineId` (optional, `permission: 'admin'`) + typed panel read (`consultation-recording-panel.tsx:73`).

---

## 3. Implementation Plan (TDD)

**Decisions (2026-06-05, approved):** I-1 uses **Option C** (reuse the already-resolved `GET /user/me/preferences` `remoteConfig.pipelineId`, injected via the admin/tenant tier — honors the per-user admin override, no new GlobalSetting key). **Single sequential TDD track** in the main worktree (I-2a/b/c are tightly coupled on the same NestJS internal path; parallelizing would collide). Each step is RED→GREEN; gates stay green per step.

### Step 1 — I-2a: route contract alignment
- **RED:** contract test asserting `gateway.create_audio_recording` posts to the path the NestJS controller actually serves (`internal/stt/audio-records`).
- **GREEN:** change the path string in `apps/stt-v2/src/stt_v2/core/api_client/gateway.py` from `/internal/stt/audio-recordings` → `/internal/stt/audio-records` (align client to the existing controller; the controller route is the established server contract and the route is internal-only, so the client is the safe side to change).
- **Files:** `gateway.py`; `apps/stt-v2/tests/unit/test_api_client.py`. **Env:** conda `arcaenv`, `PYTHONPATH=apps/stt-v2/src`.

### Step 2 — I-2b: `Media` registration endpoint
- **RED:** applications test for a new `SttInternalService.createMedia(dto)` (returns `{ id }`); API test for `POST internal/stt/media` (api-key guarded, returns the created media id).
- **GREEN:** add `CreateMediaRequest` DTO (`tenantId, name, uri, extension, mimeType, size, hash, createdBy?`), `SttInternalService.createMedia` (via `MediaFactory.CreateMedia` + `mediaRepository.create`), and `@Post('media')` on `SttInternalController`. Response shape `{ id }` so the Python `(m).get('id')` read works.
- **Files:** `packages/applications/src/services/stt/internal/{sttInternal.service.ts, dto/internal.request.ts, dto/internal.response.ts}`; `apps/api/src/modules/internal/stt-internal.controller.ts`; tests under each `__tests__`.

### Step 3 — I-2c: consultation → context attachment
- **RED:** applications test: `createAudioRecord` with `consultationId` (no `contextItemId`) resolves/creates the `AUDIO_RECORDING` container and attaches the recording; with `contextItemId` it still works (back-compat).
- **GREEN:** add optional `consultationId` to `CreateAudioRecordRequest`; in `SttInternalService.createAudioRecord`, when `contextItemId` is absent and `consultationId` present, resolve the container via the **shared** local-path logic (`findOrCreateAudioContainer`). Extract that resolver so both `ContextService` and `SttInternalService` use one implementation (no duplicate container logic). Tenant scope must be enforced (mirror `assertParentInScope`).
- **Files:** `sttInternal.service.ts`, `internal.request.ts`, `context.service.ts` (extract/share resolver), `internal.module`/DI wiring as needed; tests.

### Step 4 — I-1: pipeline-id population (Option C)
- **RED:** SDK test: after init with a `remoteConfig.pipelineId` from `/user/me/preferences`, `configManager.getResolved().stt.transcriptionPipelineId === <that id>`, and a user-pref override cannot change it (admin-permission stays enforced).
- **GREEN:** in `AgenticProvider.init()` (and the rehydrate path), after preferences load, read `remoteConfig.pipelineId` and inject it via the **tenant/admin tier** (`configManager.setTenantConfig({ stt: { transcriptionPipelineId } })`) so `stripLockedAndAdminPaths` keeps it authoritative. Confirm the panel (`consultation-recording-panel.tsx:73`) then resolves to it instead of `DEFAULT_TRANSCRIPTION_PIPELINE_ID`.
- **Files:** `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` (+ personalization/preferences read), tests under `providers/__tests__` and/or `core/__tests__`.

### Step 5 — E2E verification
- Reason through (and unit-cover) the full chain on a `dual_capture`-enabled pipeline: enabling → `Media`×(raw[/processed]) + `AudioRecording` (both ids) attached to the consultation as `AUDIO_RECORDING`; disabling → none. Run all affected gates.

### Test list (TDD)
- `test_api_client.py` — create_audio_recording posts `audio-records`; create_media posts `media` (I-2a).
- applications: `sttInternal.createMedia` returns id; `createAudioRecord` resolves container from `consultationId`; back-compat with `contextItemId` (I-2b, I-2c).
- api: `POST internal/stt/media` guarded + returns id (I-2b).
- vox: `transcriptionPipelineId` populated from `remoteConfig.pipelineId`, admin-permission enforced (I-1).

## 4. Implementation Summary

Executed as a **single sequential TDD track** on `fix/2605-review` (I-2a → I-2b → I-2c → I-1). Every step was RED→GREEN; the consolidated gate is green (§ below). Remote dual-capture is now wired end-to-end.

### I-2a — Route contract alignment
- `apps/stt-v2/src/stt_v2/core/api_client/gateway.py`: `create_audio_recording` now posts `POST /internal/stt/audio-records` (was `/audio-recordings`). Also **renamed the `duration` param → `duration_ms`** and maps it to the payload key `durationMs`, fixing a seconds-vs-milliseconds unit mismatch with the NestJS DTO; `session_manager._register_dual_capture` passes `duration_ms=int(round(total_duration_seconds * 1000))`.
- Contract tests: `test_create_audio_recording_targets_internal_route`, `test_create_media_targets_internal_route`, and an updated metadata test asserting `durationMs`.

### I-2b — `Media` registration endpoint
- `packages/applications/.../stt/internal/dto/internal.request.ts`: added `InternalCreateMediaRequest` / `InternalCreateMediaResponse` (named `Internal*` to avoid a barrel collision with the existing `media` service's `CreateMediaRequest`).
- `SttInternalService.createMedia(dto)`: `MediaFactory.CreateMedia` → `mediaRepository.create`, returns `{ id }` (the shape the Python `gateway.create_media` reads).
- `apps/api/.../internal/stt-internal.controller.ts`: `@Post('media')`, API-key guarded, delegates to the service.

### I-2c — consultation → context attachment (dual-shape `createAudioRecord`)
- `CreateAudioRecordRequest` now accepts **two shapes**: the legacy batch/local shape (`contextItemId` + storage quartet) **and** the streaming dual-capture shape (`consultationId` + `tenantId` + pre-registered `mediaId`/`rawMediaId`/`processedMediaId`). Batch-only fields were made optional; new optional fields added (`consultationId`, `tenantId`, `mediaId`). Up-front validation rejects requests that supply neither container key nor a media source (no orphan containers).
- `SttInternalService.createAudioRecord` resolves the container from `contextItemId` **or** from `consultationId` via a private `findOrCreateAudioContainer(consultationId, tenantId)`, and uses a pre-registered `mediaId` when present (else creates `Media` from the storage object — back-compat).

### I-1 — pipeline-id population (Option C)
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`: the backend-preferences load (`loadFromBackend`, `GET /user/me/preferences`) is now captured as a promise; `init()` Step 2 awaits it and injects the per-user-resolved `remoteConfig.pipelineId` into the **tenant (admin) tier** as `stt.transcriptionPipelineId` in the same `setTenantConfig(...)` call (mirrors TASK-332's `captureRawAudio`). `stt.transcriptionPipelineId` is `permission: 'admin'`, so `stripLockedAndAdminPaths` keeps it authoritative; the panel (`consultation-recording-panel.tsx:73`) resolves to it instead of `DEFAULT_TRANSCRIPTION_PIPELINE_ID`.
- Regression test: `providers/__tests__/AgenticProvider.remotePipeline.task334.test.ts` (3 cases: injected from `remoteConfig.pipelineId`; user-pref override rejected; undefined when no pipeline is assigned).

### Deviations from the plan (honest deltas)
- **I-2c resolver is mirrored, not extracted.** The plan's Step 3 GREEN proposed extracting a single shared resolver used by both `ContextService` and `SttInternalService`. Instead a 6-line private `findOrCreateAudioContainer` was added to `SttInternalService` using the already-injected `ContextItemRepository`. It is **behavior-identical** to `ContextService.findOrCreateAudioContainer` (same `findAudioRecordings` lookup, same `ContextItemFactory.CreateAudioRecording` whose `createdBy` defaults to `'system'` — matching the local path's `userId ?? 'system'`). Rationale: extracting would force a cross-service dependency (`SttInternalService → ContextService`) or a domain-layer hoist, expanding scope/risk; the existing internal `createTranscript` already constructs context items independently rather than delegating to `ContextService`. _Optional future DRY follow-up: hoist a shared `AudioContainerResolver`._
- **Tenant scope follows the internal-service trust model.** `findOrCreateAudioContainer` does not call `assertParentInScope`; it trusts the `tenantId` supplied by the API-key-guarded caller (the STT service, whose session carries the consultation's tenant), exactly as `createTranscript` trusts `job.tenantId`. `consultationId` is a UUID owned by a single tenant, so the lookup is tenant-consistent.
- **I-1 mount-init only (not the rehydrate path).** The plan mentioned "and the rehydrate path", but re-audit showed the tenant/user-switch rehydrate effect **never re-applies `configManager.setTenantConfig`** (it only refreshes `store.tenantConfig`). This is a **pre-existing limitation shared by every tenant-tier field**, including TASK-332's `captureRawAudio`. I-1 mirrors that precedent (inject at mount `init()` Step 2) to stay surgical; full rehydrate-path tenant-tier re-application is a separate, broader change tracked outside this ticket.

### Files changed
- **Python (`apps/stt-v2`):** `src/stt_v2/core/api_client/gateway.py`, `src/stt_v2/streaming/session_manager.py`, `tests/unit/test_api_client.py`.
- **applications:** `src/services/stt/internal/{sttInternal.service.ts, ISttInternalService.ts, dto/internal.request.ts}` + `__tests__/sttInternal.service.test.ts`.
- **api:** `src/modules/internal/stt-internal.controller.ts` + `__tests__/stt-internal.controller.test.ts`.
- **vox:** `src/providers/AgenticProvider.tsx` + `providers/__tests__/AgenticProvider.remotePipeline.task334.test.ts`.

### Gate evidence (`fix/2605-review`, 2026-06-05)
| Gate | Result |
|---|---|
| vox `typecheck` + `vitest` | clean · **3300 passed** (175 files; +3 new I-1 tests) |
| applications `typecheck` + `vitest` | clean · **4693 passed**, 4 skipped |
| api `vitest` | **1573 passed**, 4 skipped |
| api `build` (`nest build` + `tsc-alias`) | clean |
| ui-playground `type-check` | clean |
| stt-v2 `pytest tests/unit` (conda `arcaenv`) | **1864 passed** (+2 new contract tests) |

### E2E reasoning (dual_capture-enabled remote pipeline)
1. Admin enables `dual_capture` on a pipeline → Python `yaml_parser` parses it → `session_manager` stores it per session.
2. On finalize, `_register_dual_capture` uploads raw[/processed] WAVs → `gateway.create_media` (`POST /internal/stt/media`) returns each `mediaId` → `gateway.create_audio_recording` (`POST /internal/stt/audio-records`) with `consultationId` + `tenantId` + `rawMediaId`[/`processedMediaId`] + `durationMs`.
3. NestJS `createAudioRecord` resolves the consultation's `AUDIO_RECORDING` container (creating it if absent) and persists one `AudioRecording` carrying both media ids → attached to the consultation (parity with the local path).
4. `dual_capture` disabled → `_register_dual_capture` is a no-op → no `Media`/`AudioRecording` rows. Runtime pipeline selection uses the I-1-populated `resolvedConfig.stt.transcriptionPipelineId`.

## 5. Change History
| Date | Change | Files / Commits |
|---|---|---|
| 2026-06-05 | Ticket created from TASK-333 merge review (I-1 population + I-2 server-side gap) | — |
| 2026-06-05 | Re-audit: favorable drift (Python orchestration already complete) — §2/§3 rewritten; gaps narrowed to NestJS receiving end + SDK cascade | README |
| 2026-06-05 | **Implemented E2E (I-2a/b/c + I-1), all gates green.** Python route+unit fix; `POST /internal/stt/media`; dual-shape `createAudioRecord` with `consultationId→container`; `AgenticProvider` injects `remoteConfig.pipelineId`→`stt.transcriptionPipelineId` (admin tier). Status → Completed. | `gateway.py`, `session_manager.py`, `test_api_client.py`, `sttInternal.service.ts`(+test), `internal.request.ts`, `ISttInternalService.ts`, `stt-internal.controller.ts`(+test), `AgenticProvider.tsx`(+`AgenticProvider.remotePipeline.task334.test.ts`) |
