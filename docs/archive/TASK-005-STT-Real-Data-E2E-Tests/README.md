# TASK-005: STT Real Data E2E Tests

- **Ticket Number**: TASK-005
- **Created Date**: 2026-02-06
- **Last Updated**: 2026-02-06
- **Status**: In Progress

---

## Requirement Analysis

### Description

Add comprehensive end-to-end tests for the STT service using real audio data. The tests validate the full transcription pipeline across different engine types (ONNX vs Transformer), with and without noise cancellation and Voice Activity Detection (VAD).

### Business Context

The STT service supports multiple pipeline configurations with different inference engines and preprocessing steps. Before deploying changes, we need confidence that the entire pipeline works end-to-end with real audio, not just synthetic test data. These tests serve as regression guards for the transcription quality and pipeline integrity.

### Acceptance Criteria

1. Six E2E tests covering the matrix of:
   - 2 engines (ONNX, Transformer) x 3 feature sets (basic, +denoise, +denoise+VAD)
2. Tests use a real audio file (`20260205_52886591770282917_ml.wav`) as test fixture
3. No mocking -- tests exercise the full ML pipeline (model loading, preprocessing, inference, postprocessing)
4. Each test produces a markdown report with transcription text, timestamps, and performance metrics
5. Pipeline configurations are built inline from YAML (no database dependency)
6. Tests are marked with `@pytest.mark.e2e`, `@pytest.mark.slow`, `@pytest.mark.ml`

---

## Current State Evaluation

### Related Components

- `apps/stt/src/stt/pipeline/` -- Pipeline DTO, YAML parser, config reader
- `apps/stt/src/stt/transcription/batch_service.py` -- Batch transcription service
- `apps/stt/src/stt/transcription/preprocessing.py` -- Audio preprocessing (VAD, denoise)
- `apps/stt/src/stt/models/` -- Model loaders (HuggingFace, ONNX, NeMo)
- `apps/stt/tests/e2e/` -- Existing E2E test infrastructure

### Existing Test Infrastructure

- Existing E2E tests in `test_full_flow.py` test YAML parsing, preprocessing, caching, and serialization but do NOT invoke real ML models
- The pytest markers (`e2e`, `slow`, `ml`) and platform detection (`TEST_PLATFORM`) are already configured in `conftest.py`
- Test database infrastructure exists but is not needed for these tests (pipelines are built from YAML directly)

---

## Implementation Plan

### Approach

Build pipeline configurations directly from YAML using `PipelineYamlParser`, bypassing the database. This eliminates external dependencies while still exercising the full `BatchTranscriptionService.transcribe()` flow:

1. Parse YAML -> `PipelineSpec`
2. Wrap in `PipelineConfig` (with inline model definitions)
3. `BatchTranscriptionService` loads models via `ModelCache` -> `ONNXLoader` / `HuggingFaceLoader`
4. Full preprocessing (resample, normalize, optional VAD, optional denoise)
5. Full inference (ONNX Optimum or Transformers)
6. Full postprocessing (timestamps, punctuation)

### Test Matrix

| Test | Engine | Denoise | VAD | Description |
|---|---|---|---|---|
| #1 | ONNX | No | No | Baseline ONNX |
| #2 | Transformer | No | No | Baseline Transformer |
| #3 | ONNX | Yes (RNNoise) | No | ONNX + noise cancellation |
| #4 | Transformer | Yes (RNNoise) | No | Transformer + noise cancellation |
| #5 | ONNX | Yes (RNNoise) | Yes (Silero v5) | Full pipeline ONNX |
| #6 | Transformer | Yes (RNNoise) | Yes (Silero v5) | Full pipeline Transformer |

### Files Created/Modified

| File | Action | Description |
|---|---|---|
| `tests/e2e/fixtures/20260205_52886591770282917_ml.wav` | Created | Real audio test fixture (~3.3 MB) |
| `tests/e2e/test_real_data_transcription.py` | Created | 6 E2E test cases with markdown report output |
| `tests/e2e/output/.gitignore` | Created | Ignore generated reports, keep directory |

### Running the Tests

```bash
# From apps/stt/ directory, with ML dependencies installed

# Run all 6 real-data tests
TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s

# Run only ONNX engine tests
TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s -k "onnx"

# Run only transformer engine tests
TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s -k "transformer"

# Run a single test
TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s -k "test_01"
```

### Prerequisites

- Python environment with ML dependencies: `pip install -e ".[ml]"`
- HuggingFace models will auto-download on first run (uses `HF_HOME`)
- No database, Redis, or MinIO required

---

## Implementation Summary

### What Was Implemented

1. **Audio fixture**: Copied real audio file to `tests/e2e/fixtures/` as a permanent test artifact
2. **Test file**: Created `tests/e2e/test_real_data_transcription.py` with:
   - 6 pipeline YAML configurations (functions) for each test scenario
   - Helper to build `PipelineConfig` from YAML without database
   - Helper to generate detailed markdown reports
   - Helper to invoke `BatchTranscriptionService` directly
   - `TestRealDataTranscription` class with 6 async test methods
   - Module-scoped fixture for audio bytes (loaded once, shared across tests)
3. **Output infrastructure**: Created `tests/e2e/output/` with `.gitignore` to hold generated reports

### Design Decisions

- **No mocking**: Tests are true E2E -- they load real models and process real audio
- **No database dependency**: Pipeline configs are built from YAML directly using `PipelineYamlParser`
- **Inline model definitions (v1.1 schema)**: Models are specified with `hf_model_id` + `engine` in YAML
- **Module-scoped audio fixture**: Audio file is loaded once and shared across all 6 tests for efficiency
- **Markdown reports**: Each test writes a timestamped `.md` report to `tests/e2e/output/` for human review
- **Test markers**: `@pytest.mark.e2e`, `@pytest.mark.slow`, `@pytest.mark.ml` for selective execution

---

## Change History

_(No changes yet -- initial implementation)_
