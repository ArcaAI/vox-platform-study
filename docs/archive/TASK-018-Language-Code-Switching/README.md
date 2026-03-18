# TASK-018: Language & Code-Switching Support

- **Ticket**: TASK-018
- **Created**: 2025-02-12
- **Last Updated**: 2026-02-12
- **Status**: Completed

---

## Requirement Analysis

### Description

Enable users to:
1. **Pass a language code** when requesting transcription for audio files or audio streams, overriding the pipeline default
2. **Enable or disable multilingual code-switching** from the pipeline configuration, the transcription API, and streaming session creation

### Business Context

HOPE's STT-V2 service supports multiple ASR engines (Whisper ONNX, Transformers, Azure Speech, NeMo). Many real-world audio recordings contain speakers switching between languages (e.g. English and Malayalam, Hindi and English). Without code-switching support, the transcriber either forces a single language or relies on auto-detection that resets per chunk, producing poor results for multilingual audio.

### Acceptance Criteria

- [ ] `InferenceConfig` DTO has a `code_switching: bool` field
- [ ] Pipeline YAML supports `inference.code_switching: true/false`
- [ ] `POST /api/v1/transcribe` accepts optional `language` (validated) and `code_switching` parameters
- [ ] Language codes are validated against the Whisper-supported set (99 languages)
- [ ] Dramatiq worker (`transcribe_file`) accepts per-job `language` and `code_switching` overrides
- [ ] Streaming session creation accepts `language` and `code_switching` parameters
- [ ] Code-switching is wired through all 4 ASR inference engines (Optimum ONNX, Transformers, Azure Speech, NeMo)
- [ ] Azure Speech uses `AutoDetectSourceLanguageConfig` when code-switching is enabled
- [ ] NeMo logs a warning that code-switching is not supported

---

## Current State Evaluation

### Before This Change

| Component | Language Support | Code-Switching |
|---|---|---|
| `InferenceConfig` | `language: str \| None` (auto-detect when None) | Not supported |
| Pipeline YAML | `inference.language` parsed | Not parsed |
| `POST /api/v1/transcribe` | Optional `language` form param, overrides pipeline | Not supported |
| Dramatiq worker | No `language` param — uses pipeline default only | Not supported |
| Streaming session | No language or code-switching fields | Not supported |
| Whisper ONNX inference | `language` passed to `generate_kwargs` | Not supported |
| Azure Speech | Single language via `speech_recognition_language` | Not supported |
| NeMo | No language support | Not supported |

### Issues Found During Review

1. No code-switching configuration anywhere in the system
2. No language code validation — invalid codes passed straight to models
3. Worker couldn't accept per-job language overrides
4. Streaming sessions had no language/code-switching metadata
5. Unnecessary `hasattr` check in API route (always True for dataclass field)

---

## Implementation Plan

Six tasks organized by layer:

1. **DTO + YAML Parser** — Add `code_switching` field, language validation constants
2. **Language Validation** — `VALID_WHISPER_LANGUAGES` set + `is_valid_language_code()` helper
3. **Batch API** — Add `code_switching` param, validate language codes
4. **Inference Engines** — Wire code-switching through all 4 ASR paths
5. **Dramatiq Worker** — Accept per-job `language` + `code_switching`
6. **Streaming** — Add fields to request schema, session metadata, session manager

---

## Implementation Summary

### Files Modified

| File | Changes |
|---|---|
| `src/stt_v2/pipeline/dto.py` | Added `code_switching: bool = False` to `InferenceConfig`; added `VALID_WHISPER_LANGUAGES` set (99 languages) and `is_valid_language_code()` validation helper |
| `src/stt_v2/pipeline/yaml_parser.py` | Parse `code_switching` from YAML; validate language codes; warn when code-switching + fixed language |
| `src/stt_v2/transcription/api/routes.py` | Added `code_switching` form param; validate language with `is_valid_language_code()`; removed unnecessary `hasattr` check |
| `src/stt_v2/transcription/batch_service.py` | Wired `code_switching` through Optimum ONNX, Transformers, Azure Speech, and NeMo paths; Azure uses `AutoDetectSourceLanguageConfig` when enabled |
| `src/stt_v2/transcription/workers/transcribe_file.py` | Added `language` and `code_switching` params to actor + async impl; applies overrides to pipeline config |
| `src/stt_v2/streaming/api/schemas.py` | Added `language` and `code_switching` to `CreateStreamingSessionRequest` |
| `src/stt_v2/streaming/api/routes.py` | Passes `language` and `code_switching` through to `SessionManager.create_session()` |
| `src/stt_v2/streaming/schemas.py` | Added `language` and `code_switching` to `SessionMetadata`; updated `to_redis_dict` / `from_redis_dict` |
| `src/stt_v2/streaming/session_manager.py` | Updated `create_session()` to accept and store `language` and `code_switching` |

### How Code-Switching Works Per Engine

| Engine | Behavior with `code_switching=True` |
|---|---|
| **Whisper ONNX (Optimum)** | Omits `language` from `generate_kwargs`, letting Whisper auto-detect per chunk |
| **Whisper (Transformers)** | Same — omits `language` from `generate_kwargs` |
| **Azure Speech** | Uses `AutoDetectSourceLanguageConfig` instead of pinning `speech_recognition_language` |
| **NeMo Parakeet** | Logs warning — NeMo does not support code-switching; setting is ignored |

### Pipeline YAML Example

```yaml
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: "onnx"
    quantization: "q4"
inference:
  language: null          # auto-detect (recommended with code-switching)
  code_switching: true    # enable multilingual code-switching
  batch_size: 16
  beam_size: 5
```

### API Usage Examples

**File transcription with language override:**
```bash
curl -X POST /api/v1/transcribe \
  -F "file=@audio.wav" \
  -F "pipeline_id=my-pipeline" \
  -F "tenant_id=tenant-1" \
  -F "language=ml" \
  -F "code_switching=true"
```

**Streaming session with code-switching:**
```bash
curl -X POST /internal/streaming/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "uuid-here",
    "tenant_id": "tenant-1",
    "pipeline_id": "my-pipeline",
    "language": null,
    "code_switching": true
  }'
```

### NestJS API Gateway Changes

In addition to the Python STT-V2 changes, the NestJS API Gateway was updated to propagate `language` and `codeSwitching` from client requests through to the STT-V2 service.

| File | Changes |
|---|---|
| `packages/applications/src/services/stt/job/dto/create-job.request.ts` | Added `language?: string` and `codeSwitching?: boolean` to `CreateJobRequest`, `CreateBatchJobRequest`, and `CreateStreamingJobRequest` with Swagger + class-validator decorators |
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | Added `language?: string` and `codeSwitching?: boolean` to `CreateStreamingSessionRequest` interface |
| `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | Passes `language` and `code_switching` in the HTTP POST body to STT-V2 `POST /internal/streaming/sessions` |
| `packages/applications/src/services/stt/realtime/ITranscriptionRealtimeService.ts` | Added `language` and `codeSwitching` to `createAndStream()` params interface |
| `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts` | Passes `language` and `codeSwitching` through `createAndStream()` → `dispatchDramatiqJob()`; Dramatiq message `args` now includes `language` (pos 7) and `code_switching` (pos 8) |

### Data Flow (End-to-End)

```
Client Request (language, codeSwitching)
    │
    ▼
NestJS API Gateway
├── Batch: CreateBatchJobRequest → TranscriptionRealtimeService
│   └── dispatchDramatiqJob() → Redis HSET+RPUSH (args[6]=language, args[7]=code_switching)
│       └── Python Dramatiq worker: transcribe_file(language=..., code_switching=...)
│           └── pipeline_config.spec.inference.language / .code_switching override
│               └── ASR engine (Whisper/Azure/NeMo)
│
└── Streaming: CreateStreamingSessionRequest → StreamingSessionService
    └── POST /internal/streaming/sessions (language, code_switching)
        └── Python SessionManager.create_session(language=..., code_switching=...)
            └── SessionMetadata persisted in Redis
```

### Deviations from Plan

None — all tasks implemented as planned across both Python and NestJS layers.

---

## Testing Strategy

- Unit tests for `is_valid_language_code()` — valid codes, invalid codes, BCP-47 tags
- Unit tests for YAML parser `code_switching` parsing and validation
- Integration tests for `POST /api/v1/transcribe` with `code_switching=true`
- E2E tests with multilingual audio files (English + Malayalam)
- Verify Azure path uses `AutoDetectSourceLanguageConfig`
- Verify NeMo path logs warning and continues
- Verify NestJS DTOs validate `language` (string) and `codeSwitching` (boolean) via class-validator
- Verify Dramatiq message includes `language` and `code_switching` in args
