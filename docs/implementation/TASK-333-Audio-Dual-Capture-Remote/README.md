# TASK-333 — Audio Dual-Capture: Remote (Per-Pipeline raw/processed)

| | |
|---|---|
| **Ticket** | TASK-333 |
| **Track** | B — Remote (Python `apps/stt-v2` + TS/UI) |
| **Parent** | TASK-331 doc-06 (F2 — clinical playground dual capture) |
| **Created** | 2026-06-05 |
| **Updated** | 2026-06-05 |
| **Status** | Pending (plan — awaiting approval) |

> Sibling ticket: **TASK-332 — Audio Dual-Capture: Local (raw)**. The two run in parallel.
>
> **Open input required before any Python is written:** which **conda env** the `apps/stt-v2` work uses (per environment rule).

---

## 1. Requirement Analysis

### Description
For **REMOTE** (server-side Python STT) processing, optionally persist **raw and/or processed** audio as **steps configured per pipeline** in `AsrPipeline.configYaml` (`preprocessing.dual_capture.capture_raw`, `postprocessing.dual_capture.capture_processed`). This is **100% tenant-admin controlled, per pipeline**. Captured audio → backend storage → attached as an `AUDIO_RECORDING` context item.

### Business context
The remote streaming path **already uploads** raw+processed WAV to MinIO, but the bytes are orphaned — no DB rows, no context item, and the `dual_capture` YAML is silently ignored. This ticket makes the seeded `dual_capture` config actually do something and closes the TASK-331 doc-06 F2 remote deferral.

### Acceptance criteria
- [ ] Python parses `dual_capture` from `configYaml` (preprocessing + postprocessing).
- [ ] When enabled, the already-uploaded raw/processed WAVs are registered as `Media` + `AudioRecording` (with `rawMediaId`/`processedMediaId`) and attached to the consultation context.
- [ ] Tenant admin can configure `dual_capture` via the pipeline editor (structured, not raw-YAML-only).
- [ ] In-consultation recording uses the user's **resolved remote pipeline** (not the hardcoded `turbo`), so per-pipeline `dual_capture` applies.
- [ ] Unknown YAML keys are no longer silently ignored (warn) — hardening.
- [ ] Tests green (pytest + vitest), no regressions.

---

## 2. Current State Evaluation

| Area | Finding | Evidence |
|---|---|---|
| Seeded config | `dual_capture` is seeded on the **`production`** pipeline only (not `turbo`/others) | `seed/06-stt.ts` (`PIPELINE_CONFIGS.production`) |
| Python parser ignores it | `PreprocessingConfig`/`PostprocessingConfig` have **no** `dual_capture` field; `yaml_parser.py` never reads it → **intent-only no-op** | `apps/stt-v2/src/stt_v2/pipeline/dto.py:465,517`; `pipeline/yaml_parser.py` |
| Bytes uploaded, not registered | `_finalize_session` uploads raw+processed WAV to MinIO but **never** creates `Media`/`AudioRecording`; `gateway.create_audio_recording()` exists but is **unused** on the streaming path and **lacks** `rawMediaId`/`processedMediaId` | `apps/stt-v2/src/stt_v2/streaming/session_manager.py`; `core/api_client/gateway.py` |
| TS writer ready | `sttInternal.createAudioRecord` **already accepts** `rawMediaId`/`processedMediaId` (TASK-331 doc-06 F2) — no TS change needed for the DB write path | `packages/applications/src/services/stt/internal/sttInternal.service.ts` |
| Pipeline-selection mismatch | Consultation panel hardcodes `DEFAULT_TRANSCRIPTION_PIPELINE_ID` = `turbo` (`…0002`), which has **no** `dual_capture`; only `production` (`…0001`) does | `apps/ui-playground/.../consultation-recording-panel.tsx`; `apps/ui-playground/src/features/audio/constants.ts` |
| Admin editor gap | `PipelineConfig` interface doesn't model `dual_capture`; admins can only edit it via the raw-YAML tab | `apps/ui-playground/src/features/admin/audio-pipelines/pipeline-config-editor.tsx:~21-59` |

### Impact areas
Python `apps/stt-v2` (dto/parser/session/gateway); admin pipeline editor; consultation pipeline selection; seed alignment.

---

## 3. Implementation Plan (TDD)

### T4 — Python: honor `dual_capture` + register media  _[needs conda env — confirm first]_
- `pipeline/dto.py`: add a `dual_capture` block (`enabled`, `capture_raw` / `capture_processed`) to `PreprocessingConfig` (`:465`) and `PostprocessingConfig` (`:517`).
- `pipeline/yaml_parser.py`: parse it in `_parse_preprocessing` / `_parse_postprocessing`.
- `streaming/session_manager.py:_finalize_session`: when enabled, for the raw/processed WAVs already in MinIO, create `Media` rows + call `gateway.create_audio_recording(..., raw_media_id, processed_media_id)`; resolve `session → consultationId → contextItemId` (verify the streaming session carries `consultationId` from the panel handshake).
- `core/api_client/gateway.py:create_audio_recording`: add `raw_media_id`/`processed_media_id` params and forward to the NestJS endpoint (which maps to the already-ready `sttInternal.createAudioRecord`).
- **Hardening:** make `yaml_parser` **warn** (or reject) on unknown top-level keys so future intent-only keys don't silently no-op.
- **TDD (pytest, conda):** `yaml_parser` parses `dual_capture`; `_finalize_session` registers `Media` + calls the gateway with both ids when enabled, skips when disabled — extend `tests/unit/test_streaming_recording.py` / `test_session_manager_model_wiring.py`.

### T5 — Authoring + pipeline selection (TS/UI)
- `pipeline-config-editor.tsx`: model `dual_capture` in the `PipelineConfig` interface (structured toggles: `capture_raw` under preprocessing, `capture_processed` under postprocessing) and round-trip to YAML.
- `consultation-recording-panel.tsx`: replace the hardcoded `DEFAULT_TRANSCRIPTION_PIPELINE_ID` with the user's **resolved remote pipeline** (`UserPreferences.remoteConfig.pipelineId` via `useArcaConfig`/preferences), falling back to the tenant default — fixes the `turbo`/`production` mismatch.
- Seed alignment: ensure the selected default pipeline either has `dual_capture` or selection points at one that does (decide: enable on `turbo`, or rely on the resolved-pipeline fix).
- **TDD:** editor round-trips `dual_capture`; panel forwards the resolved pipeline id (not the constant).

### Testing strategy
- Python: pytest in the project conda env — `apps/stt-v2/tests/unit`. TS/UI: vitest (editor, panel).

### Verification criteria
- `dual_capture` parsed + honored; `Media`/`AudioRecording` rows created with both ids; context item attached.
- Per-pipeline control works (enable on one pipeline → capture; disable → none).
- Panel uses the resolved pipeline; unknown-key warning emitted.

---

## 4. Implementation Summary
_To be completed during implementation._

## 5. Change History
| Date | Change | Files / Commits |
|---|---|---|
| 2026-06-05 | Plan authored (parallel Track B of TASK-331 doc-06 F2 follow-up) | — |

---

### Cross-cutting (shared with TASK-332)
- The additive `SummaryMeta` prompt-tier migration from TASK-331 doc-06 (`20260603175719_add_summary_meta_prompt_tier`) is merged but **unapplied** — apply on the next deploy.
