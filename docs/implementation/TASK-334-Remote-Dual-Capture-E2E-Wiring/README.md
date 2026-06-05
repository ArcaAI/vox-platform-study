# TASK-334 — Remote Dual-Capture: End-to-End Wiring

| | |
|---|---|
| **Ticket** | TASK-334 |
| **Parent** | TASK-333 (Audio Dual-Capture: Remote) / TASK-331 doc-06 (F2) |
| **Created** | 2026-06-05 |
| **Updated** | 2026-06-05 |
| **Status** | Pending — follow-up (not started) |

> Spun out of the TASK-333 merge review. TASK-333 landed the **scaffolding** for remote per-pipeline dual-capture (YAML parsing, gateway forwarding, `_finalize_session` registration, the admin editor, and the typed `stt.transcriptionPipelineId` field). This ticket makes it **actually work end-to-end**. Until it lands, **TASK-333 AC#2 and AC#4 are NOT met E2E**.

---

## 1. Requirement Analysis

### Description
When a tenant admin enables `dual_capture` on a remote ASR pipeline, the raw/processed audio that the streaming path already uploads to object storage must be **registered as `Media` + `AudioRecording` rows and attached to the consultation as a context item**, and the in-consultation recorder must actually **run on that pipeline** (not the hardcoded `turbo`).

### Why it's not done in TASK-333
TASK-333 was scoped to the parts that were self-contained and safe to merge. The two remaining gaps cross the Python↔NestJS contract boundary and the SDK config-population path, which need their own design + tests.

### Acceptance criteria
- [ ] **I-2a — Route contract:** `stt-v2` `gateway.create_audio_recording` posts to the **correct** internal NestJS route (today it targets `/audio-recordings`; the controller is `/audio-records`). Aligned + covered by a contract test.
- [ ] **I-2b — Media registration endpoint:** an internal endpoint exists to register a storage object as a `Media` row (e.g. `POST /internal/stt/media`), returning the `mediaId` used for `rawMediaId`/`processedMediaId`. (Today there is no such endpoint, so the uploaded bytes can't become `Media`.)
- [ ] **I-2c — Context attachment:** the streaming path resolves `consultationId → contextItem` container so the `AudioRecording` is attached to the consultation (matching the local path's `AUDIO_RECORDING` attachment).
- [ ] **I-1 — Pipeline-id population:** the resolved remote pipeline id is surfaced into `resolvedConfig.stt.transcriptionPipelineId` from the tenant/user remote-config cascade (admin-owned), so the consultation panel runs the correct pipeline. (The schema field + typed read already exist from TASK-333 `95b77524`.)
- [ ] End-to-end: enabling `dual_capture` on the user's resolved pipeline produces `Media` + `AudioRecording` rows (both ids) attached to the consultation; disabling produces none.
- [ ] Tests green (pytest contract/integration + vitest), no regressions.

---

## 2. Current State (entry point for the implementer)

| Gap | Where | Note |
|---|---|---|
| Route name mismatch | `apps/stt-v2/src/stt_v2/core/api_client/gateway.py` → NestJS `apps/api/.../stt` internal controller | Client posts `/audio-recordings`; controller route is `/audio-records`. |
| No `Media` registration endpoint | `apps/api` internal STT module; `packages/applications/.../stt/internal` | `sttInternal.createAudioRecord` accepts `rawMediaId`/`processedMediaId`, but there is no endpoint to first turn a storage key into a `Media` row. |
| No consultation→context resolution | `apps/stt-v2/.../streaming/session_manager.py:_finalize_session` + internal STT service | Need `consultationId → contextItem` container lookup so the recording attaches (parity with TASK-332 local path). |
| Pipeline-id not populated | SDK config cascade → `AgenticProvider` / tenant-config resolver | `stt.transcriptionPipelineId` exists in `SttConfigSchema` but nothing writes it; panel falls back to `DEFAULT_TRANSCRIPTION_PIPELINE_ID` (`turbo`). |

### Already in place (from TASK-333, reuse — do not rebuild)
- Python parses `dual_capture` and `session_manager._finalize_session` calls `gateway.create_audio_recording(..., raw_media_id, processed_media_id, consultation_id)` when enabled (best-effort, non-fatal).
- `gateway.create_audio_recording` forwards `raw_media_id`/`processed_media_id`/`consultation_id`.
- `sttInternal.createAudioRecord` (TS) accepts both media ids.
- `SttConfigSchema.transcriptionPipelineId` (optional, `permission: 'admin'`) + typed panel read.

---

## 3. Implementation Plan (TDD)
_To be authored when prioritized._ Suggested order: I-2a (route) → I-2b (`Media` endpoint) → I-2c (context attach) → I-1 (population), each RED→GREEN with a contract/integration test, then an end-to-end check on a `dual_capture`-enabled pipeline.

## 4. Implementation Summary
_To be completed during implementation._

## 5. Change History
| Date | Change | Files / Commits |
|---|---|---|
| 2026-06-05 | Ticket created from TASK-333 merge review (I-1 population + I-2 server-side gap) | — |
