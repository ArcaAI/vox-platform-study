# TASK-006: Azure Speech as ASR Engine in STT-V2

- **Ticket Number**: TASK-006
- **Created Date**: 2026-02-06
- **Last Updated**: 2026-02-06
- **Status**: Completed

---

## Requirement Analysis

### Description

Add Azure Cognitive Services Speech as a first-class ASR engine in the STT-v2 pipeline architecture, alongside the existing local engines (ONNX, Transformers/SafeTensor, NeMo, CTranslate2). This is a cloud-based engine — no model files are downloaded; audio is sent to Azure's API for transcription.

### Business Context

While local engines (Whisper, NeMo, etc.) offer data-sovereignty and no per-request cost, Azure Speech provides:
- Production-grade accuracy for many languages out-of-the-box
- Speaker diarization without additional models
- No GPU requirement — offloads compute to cloud
- Rapid prototyping and deployment

Having both local and cloud engines configurable via the same YAML pipeline gives operators maximum flexibility.

### Acceptance Criteria

1. A new `AZURE_SPEECH` value in the `AiModelFormat` enum, recognized in pipeline YAML
2. An `AzureSpeechLoader` that validates credentials and produces a `LoadedModel` handle
3. An Azure-specific inference path in `BatchTranscriptionService` that returns the same `RawTranscription` DTO as local engines
4. The loader participates in the existing `ModelCache` lifecycle (cache, TTL, eviction)
5. All Azure SDK calls are non-blocking (run via `asyncio.to_thread`)
6. Domain-specific exceptions for cloud ASR errors (auth, quota, transcription)
7. Azure credentials configurable via environment variables (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`)
8. Pipeline YAML example works end-to-end

---

## Current State Evaluation

### Related Components

| Component | File | Role |
|---|---|---|
| Base loader interface | `models/base_loader.py` | `BaseModelLoader` ABC |
| Loader registry & cache | `models/cache.py` | `ModelCache` with format-to-loader mapping |
| Engine enum | `pipeline/dto.py` | `AiModelFormat` enum + `ModelRef.from_value()` |
| Batch inference | `transcription/batch_service.py` | `_run_inference` dispatcher |
| Settings | `core/config/settings.py` | Pydantic `Settings` |
| Exceptions | `core/exceptions.py` | Exception hierarchy with retry groups |
| Dependencies | `pyproject.toml` | ML/ASR dependency groups |

### Architecture Pattern

The STT-v2 service uses a **loader + cache + dispatcher** pattern:
1. Pipeline YAML references an engine (e.g. `engine: "onnx"`)
2. `ModelRef.from_value()` maps the string to an `AiModelFormat` enum
3. `ModelCache._get_loader(format)` returns the appropriate `BaseModelLoader`
4. `BatchTranscriptionService._run_inference()` dispatches to the format-specific method

Azure Speech is fundamentally different from local engines (no model files, no GPU, API-driven), but the pattern accommodates it cleanly.

---

## Implementation Plan

**Approved: 2026-02-06**

### Phase 1: Core Integration

1. Add `AZURE_SPEECH` to `AiModelFormat` enum + engine mapping aliases
2. Add Azure Speech settings to `Settings` (key, region)
3. Add cloud ASR exceptions to the exception hierarchy
4. Create `AzureSpeechLoader` implementing `BaseModelLoader`
5. Register loader in `ModelCache`
6. Add `_run_azure_speech_inference()` in `BatchTranscriptionService`
7. Add `azure-cognitiveservices-speech` to the `ml` / `ml-gpu` dependency groups (required at runtime)

---

## Implementation Summary

### Files Created

| File | Description |
|---|---|
| `src/stt_v2/models/azure_speech_loader.py` | Azure Speech loader + `normalize_language_for_azure()` utility |

### Files Modified

| File | Changes |
|---|---|
| `src/stt_v2/pipeline/dto.py` | Added `AZURE_SPEECH` to `AiModelFormat`; added `"AZURE"` and `"AZURE_SPEECH"` to engine mapping |
| `src/stt_v2/core/config/settings.py` | Added `azure_speech_key` and `azure_speech_region` settings |
| `src/stt_v2/core/exceptions.py` | Added `CloudASRError`, `CloudASRAuthError`, `CloudASRQuotaError`, `CloudASRTranscriptionError`; updated retry groups |
| `src/stt_v2/models/cache.py` | Registered `AzureSpeechLoader` for `AiModelFormat.AZURE_SPEECH` |
| `src/stt_v2/models/__init__.py` | Exported `AzureSpeechLoader` |
| `src/stt_v2/transcription/batch_service.py` | Added `_run_azure_speech_inference()` and `_azure_transcribe_sync()` methods; Azure branch in `_run_inference()` dispatcher; module-level Azure SDK imports |
| `pyproject.toml` | Added `azure-cognitiveservices-speech` to `ml` and `ml-gpu` dependency groups (always available at runtime) |

### Pipeline YAML Examples

**Inline (no database registration required):**

```yaml
version: "1.0"
models:
  asr:
    hf_model_id: "azure-speech-service"
    engine: "azure"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
preprocessing:
  target_sample_rate: 16000
inference:
  language: "en-US"
postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
```

**With region override in `source_uri`:**

```yaml
models:
  asr:
    hf_model_id: "westeurope"
    engine: "azure"
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AZURE_SPEECH_KEY` | Yes (for Azure engine) | Azure Speech subscription key |
| `AZURE_SPEECH_REGION` | Yes (for Azure engine) | Azure region (e.g. `eastus`) |

### Key Design Decisions

1. **`SpeechConfig` as the "model" object**: The loader stores a lightweight, thread-safe `SpeechConfig` in `LoadedModel.model`. This participates in the LRU cache like any other model but uses zero memory.

2. **`asyncio.to_thread` for all Azure SDK calls**: The Azure Speech SDK is synchronous/blocking. All heavy operations are wrapped in `asyncio.to_thread()` to avoid blocking the event loop.

3. **Conversation transcriber (not simple recognizer)**: Uses `ConversationTranscriber` which supports speaker diarization natively, matching the output richness of local engines.

4. **Temp-file approach for audio**: Azure SDK requires file paths for batch recognition. Audio is written to a temp WAV file, used, then cleaned up in a `finally` block.

5. **Cloud-specific exceptions**: Separate from `ModelError` hierarchy. `CloudASRAuthError` is non-retryable; `CloudASRQuotaError` is retryable with backoff.

6. **Language normalization**: `normalize_language_for_azure()` converts short codes (`en` -> `en-US`) and passes BCP-47 codes through unchanged.

### Testing

```bash
# Install all ML dependencies (includes Azure Speech SDK)
pip install -e ".[ml]"

# Run unit tests (mock Azure SDK)
pytest tests/unit/models/test_azure_speech_loader.py -v

# Run E2E with real Azure credentials
AZURE_SPEECH_KEY=<key> AZURE_SPEECH_REGION=<region> \
  TEST_PLATFORM=all pytest tests/e2e/ -v -s -k "azure"
```

---

## Change History

### Update 1 — 2026-02-06: Non-optional dependency

**Issue**: Azure SDK was placed in a separate `[azure]` optional dependency group, requiring manual `pip install -e ".[azure]"`. Since stt-v2 is a unified pipeline service that must handle any engine at runtime, all ASR dependencies must be available without separate installation.

**Changes**:
- Moved `azure-cognitiveservices-speech` into the `ml` and `ml-gpu` dependency groups
- Removed standalone `[azure]` optional group from `pyproject.toml`
- Moved all Azure SDK imports to module-level (no more lazy `ImportError` guards)
- Removed `azure` from mypy ignore and coverage exclude lists
- Removed `azure_speech_loader.py` from coverage omit (now properly testable)

**Files modified**: `pyproject.toml`, `models/azure_speech_loader.py`, `transcription/batch_service.py`
