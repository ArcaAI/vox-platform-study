# TASK-019: STT End-to-End API Tests with Real Data

- **Ticket**: TASK-019
- **Created**: 2026-02-13
- **Last Updated**: 2026-02-15
- **Status**: Completed

---

## Goal

Implement comprehensive e2e tests against all 16 STT HTTP API endpoints using real audio data, covering happy paths, error scenarios, and cross-endpoint workflows.

## Architecture Overview

Tests hit the real FastAPI application (via `httpx.AsyncClient` + `ASGITransport`) backed by real infrastructure (PostgreSQL, Redis, MinIO via monorepo test containers). Real `.wav` audio fixtures are used for transcription. The test suite is organized into **5 parallel tracks** developed independently.

## Tech Stack

- **Test framework**: pytest 9+, pytest-asyncio (auto mode)
- **HTTP client**: httpx `AsyncClient` with `ASGITransport`
- **Infrastructure**: PostgreSQL (port 5433), Redis (port 6380), MinIO (port 9002) via `pnpm docker:test:up`
- **Audio fixtures**: Real `.wav` files in `tests/e2e/fixtures/`
- **Conda environment**: `stt`
- **Markers**: `@pytest.mark.e2e`, `@pytest.mark.slow`, `@pytest.mark.ml`

---

## Implementation Summary

All 5 tracks + shared infrastructure (Task 0) have been implemented. Each track also underwent a testing anti-pattern audit to harden assertions and add edge cases.

### Files Created/Modified

| Action | File | Lines | Tests | Track |
|--------|------|------:|------:|-------|
| Modified | `apps/stt/tests/e2e/conftest.py` | 244 | — | Task 0 (shared) |
| Created | `apps/stt/tests/e2e/test_health_endpoints_comprehensive.py` | 459 | 32 | Track A |
| Created | `apps/stt/tests/e2e/test_transcription_http_api.py` | 858 | 29 | Track B |
| Created | `apps/stt/tests/e2e/test_internal_endpoints_comprehensive.py` | 750 | 63 | Track C |
| Created | `apps/stt/tests/e2e/test_streaming_sessions_api.py` | 997 | 48 | Track D |
| Created | `apps/stt/tests/e2e/test_cross_endpoint_workflows.py` | 795 | 17 | Track E |
| **Total** | **5 new + 1 modified** | **4,103** | **189** | |

### Track Details

#### Task 0: Shared Conftest Enhancements

**File**: `tests/e2e/conftest.py`

Fixtures added:
- `real_audio_client` (session-scoped) — `AsyncClient` against real monorepo test infra (PostgreSQL:5433, Redis:6380, MinIO:9002), 300s timeout for ML inference
- `real_ml_audio_bytes` (session-scoped) — loads `20260205_52886591770282917_ml.wav` from `tests/e2e/fixtures/`
- `real_en_audio_bytes` (session-scoped) — loads `20260206_52886591770369502_en.wav`
- `valid_pipeline_id` (session-scoped) — defaults to `whisper-large-v3-turbo`, overridable via `TEST_PIPELINE_ID`
- `valid_tenant_id` (session-scoped) — defaults to `t-default-test`, overridable via `TEST_TENANT_ID`
- `sample_wav_audio` — 2s 440 Hz sine wave WAV (for error tests that don't need real audio)

Existing fixtures preserved: `configured_app` (testcontainers), `event_loop`, container fixtures.

---

#### Track A: Health & Metrics — 32 tests, 6 classes

**File**: `test_health_endpoints_comprehensive.py` (459 lines)
**ML deps**: No
**Fixture**: `configured_app` (testcontainers)

| Class | Tests | Endpoints Covered |
|-------|------:|-------------------|
| `TestHealthEndpointE2E` | 5 | `GET /health` — schema, timestamp freshness, performance < 500ms, JSON content-type, HEAD method, 10 concurrent |
| `TestLivenessEndpointE2E` | 4 | `GET /live` — exact response match, performance < 100ms, idempotency (5x), JSON content-type |
| `TestReadinessEndpointE2E` | 7 | `GET /ready` — full schema, required components, latency bounds, healthy cross-validation, nullable message, 5 concurrent |
| `TestMetricsEndpointE2E` | 6 | `GET /metrics` — Prometheus format, line count, HTTP metrics, text/plain, process metrics, no duplicate families |
| `TestNotFoundRouteE2E` | 8 | 404 with detail body, 404 under `/api/v1/` and `/internal/`, 405 for POST/DELETE/PUT/PATCH on health endpoints |
| `TestCORSHeadersE2E` | 2 | OPTIONS preflight, GET with Origin header |

---

#### Track B: Transcription HTTP API — 29 tests, 2 classes

**File**: `test_transcription_http_api.py` (858 lines)
**ML deps**: Happy-path tests = Yes; Error tests = No
**Fixtures**: `real_audio_client` (happy path), `configured_app` (errors)

| Class | Tests | Coverage |
|-------|------:|----------|
| `TestTranscribeHttpHappyPath` | 11 | `POST /api/v1/transcribe` — EN audio, ML audio, full Pydantic schema validation, word/sentence timestamps, timing metrics, optional params (language, consultation_id, code_switching), BCP-47 language tag |
| `TestTranscribeHttpErrors` | 18 | 400 empty file, 413 oversized (101 MB), 413 boundary (100 MB exact), 404 pipeline not found, 400 invalid language (mocked pipeline reader), 422 missing required fields, wrong HTTP methods (GET/PUT/DELETE), JSON instead of multipart, error response schema validation |

**Design note**: B7 (INVALID_LANGUAGE) mocks `get_pipeline_reader` because language validation runs after pipeline lookup and the testcontainers DB has no seeded pipelines. Helper `_make_mock_pipeline_config()` centralizes mock setup. Helper `_assert_error_response()` validates full error response shape.

---

#### Track C: Internal Admin Endpoints — 63 tests, 8 classes

**File**: `test_internal_endpoints_comprehensive.py` (750 lines)
**ML deps**: No
**Fixture**: `configured_app` (testcontainers)

| Class | Tests | Endpoints |
|-------|------:|-----------|
| `TestCacheStatsEndpointE2E` | ~10 | `GET /internal/cache/stats` — schema, types, empty state, `max_memory_mb > 0`, `total_models <= max_models`, content-type, 405 |
| `TestCacheClearEndpointE2E` | ~8 | `POST /internal/cache/clear` — empty cache, idempotency (3x), content-type, 405 |
| `TestCacheModelLookupE2E` | ~8 | `GET /internal/cache/model/{slug}` — 404 with slug in detail, special chars, unicode slug, 405 |
| `TestPipelinesLoadedE2E` | ~9 | `GET /internal/pipelines/loaded` — schema, pipeline entry fields, `ready <= total`, `is_ready` vs `missing_models` consistency, 405 |
| `TestSessionsEndpointE2E` | ~7 | `GET /internal/sessions` — list, `active_sessions == len(sessions)`, `not_initialized` state, content-type, 405 |
| `TestSessionsCleanupE2E` | ~8 | `POST /internal/sessions/cleanup` — default max_age=3600, custom max_age, 422 for invalid, 405 |
| `TestStreamingStatusE2E` | ~6 | `GET /internal/streaming/status` — schema, `not_initialized` message, content-type, 405 |
| `TestInternalEndpointConsistencyE2E` | ~5 | Cross-endpoint: sessions vs streaming status, cache clear vs stats, all timestamps valid, pipeline ready vs cache |

---

#### Track D: Streaming Sessions API — 48 tests, 10 classes

**File**: `test_streaming_sessions_api.py` (997 lines)
**ML deps**: No
**Fixtures**: `configured_app` (not-initialized tests), `streaming_initialized_app` and `small_capacity_app` (initialized tests via mocked `SessionManager`)

| Class | Tests | Scenario |
|-------|------:|----------|
| `TestStreamingAvailabilityE2E` | 6 | `GET .../availability` — always 200, schema, not-initialized values, content-type, 405, numeric invariant |
| `TestCreateStreamingSessionNotInitializedE2E` | 9 | `POST .../sessions` — 503 when not init, 422 missing fields, 422 wrong types, extra fields accepted, content-type, 405 |
| `TestGetStreamingSessionNotInitializedE2E` | 5 | `GET .../sessions/{id}` — 503, error detail, content-type, 405, special chars in session_id |
| `TestDeleteStreamingSessionNotInitializedE2E` | 4 | `DELETE .../sessions/{id}` — 503, error detail, 405 |
| `TestStreamingAvailabilityInitializedE2E` | 2 | Availability with initialized manager |
| `TestCreateStreamingSessionInitializedE2E` | 6 | 201 created, schema, optional fields, `microphone_id`, `reason` field |
| `TestGetStreamingSessionInitializedE2E` | 5 | 200 found, 404 not found, schema, content-type |
| `TestDeleteStreamingSessionInitializedE2E` | 3 | 204 no body, 404 not found |
| `TestStreamingSessionFullLifecycleE2E` | 3 | Create → get → delete, verify deleted=404, duplicate session idempotency |
| `TestStreamingSessionAtCapacityE2E` | 5 | 503 at capacity, `Retry-After` header, availability reflects capacity, error body structure |

**Design note**: Uses `_FakeStreamSession` with `__slots__` instead of `MagicMock` for stricter attribute checks. Shared `_make_mock_session_manager(max_streams)` factory.

---

#### Track E: Cross-Endpoint Workflows — 17 tests, 4 classes (originally 18, pending recount)

**File**: `test_cross_endpoint_workflows.py` (795 lines)
**ML deps**: Yes (E1, E3, E4 classes), No (E2 class)
**Fixtures**: `real_audio_client` (ML tests), `configured_app` (streaming tests)

| Class | Tests | Workflow |
|-------|------:|----------|
| `TestGatewayTranscriptionWorkflowE2E` | 3 | Health → Ready → Transcribe (EN + ML), cache verification, Pydantic round-trip |
| `TestGatewayStreamingWorkflowE2E` | 7 | Availability → create → get → delete, double-delete=404, 503 when not init, 422 empty body, GET nonexistent, availability invariant |
| `TestCacheInteractionWorkflowE2E` | 3 | Clear → transcribe → repopulate, second transcription hits cache, double clear + transcribe |
| `TestConcurrentTranscriptionE2E` | 5 | 2 concurrent transcriptions, health + transcribe parallel, 4-endpoint concurrent, cache-clear during transcription |

---

## Endpoint Coverage Matrix

| # | Endpoint | Before TASK-019 | After TASK-019 |
|---|----------|----------------|----------------|
| 1 | `GET /health` | Happy-path only | 5 tests: schema, freshness, perf, HEAD, concurrent |
| 2 | `GET /live` | Happy-path only | 4 tests: exact match, perf, idempotency |
| 3 | `GET /ready` | Happy-path only | 7 tests: full schema, components, latency bounds, cross-validation |
| 4 | `GET /metrics` | Basic check | 6 tests: Prometheus format, HTTP metrics, duplicates |
| 5 | `POST /api/v1/transcribe` | Worker flow only | 29 tests: HTTP multipart, real audio, errors (400/404/413/422), schema |
| 6 | `GET /internal/cache/stats` | Happy-path only | ~10 tests: schema, types, empty state, invariants |
| 7 | `POST /internal/cache/clear` | Happy-path only | ~8 tests: idempotency, content-type |
| 8 | `GET /internal/cache/model/{slug}` | 404 only | ~8 tests: detail message, special chars, unicode |
| 9 | `GET /internal/pipelines/loaded` | Happy-path only | ~9 tests: schema, entry fields, consistency |
| 10 | `GET /internal/sessions` | Happy-path only | ~7 tests: list, count, not_initialized |
| 11 | `POST /internal/sessions/cleanup` | Happy-path only | ~8 tests: default/custom max_age, 422 |
| 12 | `GET /internal/streaming/status` | **Not tested** | ~6 tests: schema, not_initialized |
| 13 | `POST /internal/streaming/sessions` | **Not tested** | 15 tests: 503, 422, 201, schema, lifecycle, capacity |
| 14 | `GET /internal/streaming/sessions/{id}` | **Not tested** | 10 tests: 503, 404, 200, schema |
| 15 | `DELETE /internal/streaming/sessions/{id}` | **Not tested** | 7 tests: 503, 404, 204 no-body |
| 16 | `GET /internal/streaming/availability` | **Not tested** | 8 tests: schema, not_initialized, initialized, invariant |

**Total new tests: 189** across 5 files and 30 test classes.

---

## How to Run the E2E Tests

### Prerequisites

```bash
# 1. Activate the conda environment
conda activate stt

# 2. Install test + ML dependencies (if not already installed)
cd apps/stt
pip install -e ".[ml,test]"

# 3. Start monorepo test infrastructure (PostgreSQL, Redis, MinIO)
#    Run from the monorepo root:
cd /Users/taphuynh/Desktop/igglo/ARCAAI/HOPE/docs
pnpm docker:test:up

# 4. Verify infrastructure is running:
pnpm docker:test:status

# 5. Ensure real audio fixtures exist (for Tracks B and E):
ls apps/stt/tests/e2e/fixtures/*.wav
#    Expected:
#      20260205_52886591770282917_ml.wav   (multilingual)
#      20260206_52886591770369502_en.wav   (English)
```

### Running All New E2E Tests at Once

```bash
cd apps/stt

# All new TASK-019 tests (includes ML-dependent tests)
TEST_PLATFORM=all conda run --no-banner -n stt \
  pytest tests/e2e/test_health_endpoints_comprehensive.py \
         tests/e2e/test_transcription_http_api.py \
         tests/e2e/test_internal_endpoints_comprehensive.py \
         tests/e2e/test_streaming_sessions_api.py \
         tests/e2e/test_cross_endpoint_workflows.py \
  -v --tb=short
```

### Running Individual Tracks

```bash
cd apps/stt

# ── Track A: Health & Metrics (fast, NO ML deps) ──────────────────────
conda run --no-banner -n stt \
  pytest tests/e2e/test_health_endpoints_comprehensive.py -v --tb=short

# ── Track B: Transcription HTTP API ───────────────────────────────────
# Error tests only (fast, no ML deps, no audio fixtures needed):
conda run --no-banner -n stt \
  pytest tests/e2e/test_transcription_http_api.py -v --tb=short \
  -k "TestTranscribeHttpErrors"

# Happy-path tests (slow, needs ML deps + real audio fixtures):
TEST_PLATFORM=all conda run --no-banner -n stt \
  pytest tests/e2e/test_transcription_http_api.py -v -s --tb=short \
  -k "TestTranscribeHttpHappyPath"

# ── Track C: Internal Admin (fast, NO ML deps) ────────────────────────
conda run --no-banner -n stt \
  pytest tests/e2e/test_internal_endpoints_comprehensive.py -v --tb=short

# ── Track D: Streaming Sessions (fast, NO ML deps) ────────────────────
conda run --no-banner -n stt \
  pytest tests/e2e/test_streaming_sessions_api.py -v --tb=short

# ── Track E: Cross-Endpoint Workflows ─────────────────────────────────
# Streaming-only workflows (fast, no ML):
conda run --no-banner -n stt \
  pytest tests/e2e/test_cross_endpoint_workflows.py -v --tb=short \
  -k "TestGatewayStreamingWorkflowE2E"

# All workflows (slow, needs ML + audio fixtures):
TEST_PLATFORM=all conda run --no-banner -n stt \
  pytest tests/e2e/test_cross_endpoint_workflows.py -v -s --tb=short
```

### Running Only Non-ML Tests (fast, ~2-3 min)

```bash
cd apps/stt

conda run --no-banner -n stt \
  pytest tests/e2e/test_health_endpoints_comprehensive.py \
         tests/e2e/test_internal_endpoints_comprehensive.py \
         tests/e2e/test_streaming_sessions_api.py \
         tests/e2e/test_transcription_http_api.py::TestTranscribeHttpErrors \
         tests/e2e/test_cross_endpoint_workflows.py::TestGatewayStreamingWorkflowE2E \
  -v --tb=short
```

### Using the Makefile

```bash
cd apps/stt

# Runs ALL e2e tests (existing + new):
make test-e2e
```

### Environment Variable Overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `TEST_PLATFORM` | `cpu` | Set to `all` to include ML-marked tests |
| `TEST_PIPELINE_ID` | `whisper-large-v3-turbo` | Pipeline ID/slug for transcription tests |
| `TEST_TENANT_ID` | `t-default-test` | Tenant ID for transcription tests |
| `TEST_DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5433/stt_test` | Test DB URL |
| `TEST_REDIS_URL` | `redis://localhost:6380/0` | Test Redis URL |
| `TEST_MINIO_ENDPOINT` | `localhost:9002` | Test MinIO endpoint |

### Quick Smoke Test (fastest possible validation)

```bash
cd apps/stt

# Just health endpoints — verifies test infra + conftest work:
conda run --no-banner -n stt \
  pytest tests/e2e/test_health_endpoints_comprehensive.py::TestHealthEndpointE2E \
  -v --tb=short
```

---

## Previous E2E Tests (unchanged)

These files existed before TASK-019 and remain as-is:

| File | Purpose | Tests |
|------|---------|------:|
| `test_health_endpoints.py` | Original health endpoint happy-path | 4 |
| `test_internal_endpoints.py` | Original internal endpoint happy-path | 6 |
| `test_full_flow.py` | Component-level flow tests (storage, pipeline, cache) | 7 classes |
| `test_real_data_transcription.py` | Real-data transcription via worker pipeline | 4 |
| `test_azure_speech_flow.py` | Azure Speech YAML parsing + mocked/real flow | 3 classes |

---

## Change History

### 2026-02-13 — Initial Implementation (all tracks)

All 5 tracks implemented in parallel sessions:

- [Track A Health Tests](1d42ff94) — 32 tests, health/liveness/readiness/metrics + CORS + 404/405
- [Track B Transcription Tests](25109de4) — 29 tests, HTTP multipart upload + error scenarios
- [Track C Internal Tests](d9533276) — 63 tests, cache/pipelines/sessions/streaming-status + consistency
- [Track D Streaming Tests](f9d32e7c) — 48 tests, session lifecycle + capacity + initialized/not-initialized
- [Track E Workflow Tests](432ea1f8) — 17 tests, gateway workflows + cache interaction + concurrency

Each track underwent a testing anti-pattern audit addressing:
- **#4 Incomplete validation** — added full Pydantic `model_validate()`, mandatory field assertions, cross-field invariants
- **#5 Silent pass-through** — replaced `if condition: assert` patterns with `pytest.skip()` or unconditional assertions
- **Edge cases** — 405 wrong methods, unicode slugs, concurrent requests, duplicate operations, boundary conditions

### 2026-02-14 — Dtype Mismatch Bug Fix + HuggingFace Pipeline Test Coverage

**Issue**: Production error when calling `/transcribe`:
```
TRANSCRIPTION_ERROR: Input type (float) and bias type (c10::Half) should be the same
```

**Root Cause Analysis** (3 bugs found):

1. **`_get_device()` called with compute_type string** — All three model loaders (`HuggingFaceLoader`, `ONNXLoader`, `NeMoLoader`) were calling `self._get_device(model_config.compute_type or "auto")`, passing precision strings like `"float16"` as device names. The `_get_device()` method returns unknown strings as-is, so `"float16"` was passed to `model.to("float16")`.

2. **Missing dtype cast in `_run_transformers_inference`** — The HuggingFace processor always outputs `float32` tensors. When the model is loaded in `float16` (on GPU/MPS with `auto` compute type), `generate()` receives float32 inputs but has float16 bias weights, causing the PyTorch dtype mismatch error.

3. **Unsafe default `compute_type: float16`** — The `InferenceConfig` dataclass and YAML parser both defaulted `compute_type` to `"float16"`, which causes dtype mismatches on CPU (where float16 is emulated and slower).

**Fixes Applied**:

| File | Change |
|------|--------|
| `models/huggingface_loader.py` | Changed `_get_device(model_config.compute_type or "auto")` → `_get_device("auto")` |
| `models/onnx_loader.py` | Changed `_get_device(model_config.compute_type or "auto")` → `_get_device("auto")` |
| `models/nemo_loader.py` | Changed `_get_device(model_config.compute_type or "auto")` → `_get_device("auto")` |
| `transcription/batch_service.py` | Added dtype casting in `_run_transformers_inference`: inputs are cast to `model.dtype` for floating-point tensors, preventing the float32/float16 mismatch |
| `pipeline/dto.py` | Changed `InferenceConfig.compute_type` default from `"float16"` to `"auto"` |
| `pipeline/yaml_parser.py` | Changed parser default from `"float16"` to `"auto"` |

**Test Coverage Gap Identified**:

The existing e2e tests only exercised the ONNX (Optimum) pipeline path via `turbo-whisper-large-v3`. The HuggingFace/Transformers path (`_run_transformers_inference`) had **zero** e2e coverage, which is why this production bug went undetected.

**New Test File**: `tests/e2e/test_huggingface_pipeline.py` — 19 tests covering:

| Test Class | Tests | Coverage |
|------------|------:|----------|
| `TestDtypeCastingFix` | 8 | Verifies all loaders call `_get_device("auto")`, dtype mapping, input casting, **CPU float16 safety guard** |
| `TestComputeTypeDefaults` | 5 | Verifies `auto` default, explicit float16/float32/auto preserved |
| `TestHuggingFacePipelineTranscription` | 6 | Full e2e through `/transcribe` with HF pipeline, dtype mismatch regression test, **explicit float16 on CPU test** |

---

## Change History

### Update 1 — 2026-02-13: CPU float16 Crash on Intel Server

**Issue**: Production Intel CPU-only Ubuntu server returned:
```
TRANSCRIPTION_ERROR: Input type (float) and bias type (c10::Half) should be the same
```

**Root Cause**: The `AiModel` database table has `computeType=float16` for all SAFETENSOR ASR models (correct for GPU). When the `production-whisper-large-v3` pipeline uses a slug reference like `"whisper-large-v3"`, the model is loaded via `HuggingFaceLoader` with `torch_dtype=torch.float16`. On CPU-only servers, PyTorch cannot perform fp16 inference — CPU kernels don't support half-precision operations.

**Call chain**:
1. Pipeline YAML: `models.asr: "whisper-large-v3"` (slug reference)
2. DB lookup: `AiModel` → `format=SAFETENSOR`, `computeType=float16`
3. `HuggingFaceLoader.load()` → `_get_torch_dtype("float16")` → `torch.float16`
4. `WhisperForConditionalGeneration.from_pretrained(torch_dtype=torch.float16)` loads model in fp16
5. Processor outputs float32 input tensors → `model.generate()` → **dtype mismatch crash**

**Defense-in-Depth Fix** (2 layers):

| Layer | File | Change |
|-------|------|--------|
| **1. Model Loading** | `models/base_loader.py` | `_get_torch_dtype()` now detects CPU-only environment and silently downgrades `float16`/`bfloat16` → `float32` with a warning log |
| **2. Inference** | `transcription/batch_service.py` | `_run_transformers_inference()` checks if model is fp16 on CPU and calls `asr_model.float()` to cast all parameters to float32 before inference |

**Why not change the seed data?** The `computeType=float16` in the `AiModel` table is correct for GPU deployments. The code should treat it as a **hint** and override when hardware doesn't support it.

**New Tests Added**:

| Test | Purpose |
|------|---------|
| `test_cpu_float16_guard_in_get_torch_dtype` | Verifies `_get_torch_dtype("float16")` returns `float32` on CPU (mocks CUDA/MPS as unavailable) |
| `test_cpu_float16_guard_in_batch_inference` | Verifies `_run_transformers_inference` contains the CPU fp16 → fp32 cast guard |
| `test_hf_float16_on_cpu_does_not_crash` | Full e2e: creates pipeline with `compute_type: float16`, transcribes audio, asserts no `c10::Half` error |

---

### Update 2 — 2026-02-13: 72s Transcription on K3s Intel CPU (Performance)

**Issue**: A 4.5-second audio file took 72 seconds to transcribe on a K3s cluster (Intel CPU, 8 cores, 16Gi RAM). Real-time factor = 16x, far exceeding the acceptable ~2-5x for CPU inference.

**Root Cause Analysis** (3 contributing factors):

1. **No model preloading at startup** — The ASR model (Whisper Large V3, ~6GB SAFETENSOR) is loaded lazily on the first `/transcribe` request. This includes downloading from HuggingFace Hub (if not cached on disk) and deserializing weights into RAM. For a 6GB model on CPU, this takes 30-60 seconds.

2. **No PyTorch CPU threading configuration** — PyTorch defaults to `OMP_NUM_THREADS` if set, or auto-detects from the OS. In K8s containers, this can result in suboptimal thread counts (either 1 thread or over-subscribing beyond the cgroup CPU limit). Neither `torch.set_num_threads()` nor `OMP_NUM_THREADS` was set anywhere in the application.

3. **float16→float32 runtime cast on every request** — The inference guard added in Update 1 called `asr_model.float()` which creates a full copy of the model (~6GB allocation + conversion) on every request. Fixed to persist the cast model back into the `LoadedModel` cache entry.

**Fixes Applied**:

| File | Change |
|------|--------|
| `main.py` | Added `_configure_torch_threading()` — sets `torch.set_num_threads()`, `OMP_NUM_THREADS`, `MKL_NUM_THREADS` from settings or auto-detect at startup, before any model loading |
| `main.py` | Added `_preload_pipeline_models()` — reads `PRELOAD_PIPELINES` env var (comma-separated slugs), loads all models into cache during startup lifespan, eliminating cold-start latency |
| `core/config/settings.py` | Added `torch_num_threads`, `torch_num_interop_threads`, `preload_pipelines` settings |
| `transcription/batch_service.py` | Fixed float32 cast to persist in `LoadedModel` via `model.model = asr_model` so subsequent requests skip the cast |
| `docker/Dockerfile` | Added threading env var documentation, increased health check `start-period` to 120s for model preloading |

**Expected Performance After Fix**:

| Metric | Before | After (warm cache) |
|--------|--------|---------------------|
| First request (cold) | ~72s | ~72s (moved to startup preload) |
| Subsequent requests | ~72s (if cast repeated) | ~5-15s (model cached, threads configured) |
| Startup time | ~5s | ~60-90s (model preloading) |

**K8s Deployment Configuration Required**:

```yaml
env:
  - name: PRELOAD_PIPELINES
    value: "turbo-whisper-large-v3"  # or your production pipeline slug
  - name: TORCH_NUM_THREADS
    value: "8"  # match CPU request/limit
  - name: OMP_NUM_THREADS
    value: "8"
  - name: MKL_NUM_THREADS
    value: "8"
```

Also increase the readiness probe `initialDelaySeconds` to 120-180s to allow model preloading to complete before the pod receives traffic.

---

## Change History

### Update 1 — 2026-02-15: Dockerfile Review & Optimization

**Issue**: The `docker/Dockerfile` had multiple best-practice violations, missing `.dockerignore`, and the ml-runtime stage bypassed the multi-stage builder pattern entirely.

**Changes Made**:

| # | Issue | Fix |
|---|-------|-----|
| 1 | Deprecated lowercase `as` in `FROM ... as` | Changed to uppercase `AS` (BuildKit standard) |
| 2 | No `.dockerignore` file | Created `.dockerignore` excluding `.venv/`, `tests/`, `__pycache__/`, `.env`, `.git/`, etc. |
| 3 | ml-runtime stage ran `pip install` directly (no builder separation) | Added dedicated `gpu-builder` stage that compiles packages, then copies only site-packages into the final ml-runtime image |
| 4 | Missing `README.md` in COPY for builder (breaks setuptools since `readme = "README.md"` is declared) | Added `COPY README.md ./` alongside `pyproject.toml` |
| 5 | Missing `curl` in runtime stage (HEALTHCHECK always fails) | Added `curl` to the runtime stage's `apt-get install` |
| 6 | Redundant `RUN` layers for user creation (`useradd` + `chown` + `mkdir` as separate layers) | Combined into single `RUN` layer |
| 7 | No OCI image labels | Added `org.opencontainers.image.*` labels (title, description, version, vendor, source) |
| 8 | `pip install` without `--no-compile` (generates unused `.pyc` since `PYTHONDONTWRITEBYTECODE=1`) | Added `--no-compile` flag to all `pip install` commands |
| 9 | Deprecated `TRANSFORMERS_CACHE` env var alongside `HF_HOME` | Removed `TRANSFORMERS_CACHE`, kept only `HF_HOME` |
| 10 | `ENV` directives as separate lines | Consolidated into single `ENV` blocks to reduce layers |

**Files Modified**:
- `apps/stt/docker/Dockerfile` — Full rewrite with 5 stages (builder, gpu-builder, runtime, ml-runtime, worker)
- `apps/stt/.dockerignore` — New file

**Status**: Completed
