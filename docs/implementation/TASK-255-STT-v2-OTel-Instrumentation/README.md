# TASK-255: STT-v2 OpenTelemetry Instrumentation

| Field | Value |
|-------|-------|
| **Ticket** | TASK-255 |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 |
| **Status** | In Progress |
| **Type** | Infrastructure |
| **Priority** | High |
| **Parent** | TASK-251 (Observability Stack) |

---

## 1. Requirement Analysis

### 1.1 Description

Wire the STT-v2 service (`apps/stt-v2/`) with structured logging, OpenTelemetry distributed tracing, request context propagation, and custom Prometheus metrics so it integrates with the TASK-251 observability stack (OTel Collector, Prometheus, Loki, Tempo, Grafana).

### 1.2 Business Context

- STT-v2 scored **3.5/10** in the TASK-251 service audit — the worst of all HOPE services
- 7 OpenTelemetry packages were installed as dependencies but **zero instrumentation code** existed
- `structlog` was used in 18 files but **never configured** — logs were unstructured dev format
- No request context (requestId, traceId, spanId) in any logs
- No custom Prometheus metrics (only default HTTP metrics)
- Blocks TASK-251 Phase 2: Server-Side Telemetry Wiring

### 1.3 Acceptance Criteria

- [x] `structlog.configure()` called at startup with JSON renderer
- [x] `RequestIDMiddleware` generates/propagates X-Request-ID and binds to structlog contextvars
- [x] `RequestLoggingMiddleware` logs request lifecycle (start/complete/failed with duration)
- [x] `setup_telemetry()` configures TracerProvider + OTLP gRPC exporter + FastAPI/HTTPX auto-instrumentation
- [x] OTel is conditional on `OTEL_ENABLED=true` (safe default: disabled)
- [x] 14 custom Prometheus metrics defined covering transcription, streaming, models, VAD, workers
- [x] Settings class includes `otel_enabled`, `otel_exporter_endpoint`, `otel_service_name`, `metrics_enabled`
- [x] `.env.example` documents all observability env vars
- [x] Dockerfiles include OTEL_* env var defaults
- [x] Prometheus metrics conditional on `METRICS_ENABLED=true`
- [ ] (Future) Migrate 21 stdlib logging files to `get_logger()`
- [ ] (Future) Convert 70+ f-string log calls to structured kwargs

---

## 2. Current State (Before)

### 2.1 Audit Scorecard

| Pillar | Score | Issue |
|--------|-------|-------|
| Structured Logging | 3/10 | structlog used but never configured (dev renderer) |
| Prometheus Metrics | 3/10 | Default HTTP metrics only, zero custom |
| Distributed Tracing | 0/10 | 7 OTel packages installed, zero code |
| Request Context | 0/10 | No request ID, trace ID, span ID |
| Health Checks | 8/10 | Good — DB, MinIO, Redis, streaming |

### 2.2 Critical Findings

1. No `structlog.configure()` — unstructured dev format output
2. Zero OTel instrumentation code — 7 packages are dead weight
3. No `RequestIDMiddleware` — concurrent request logs indistinguishable
4. Mixed logging: 18 files structlog, 21 files stdlib (not integrated)
5. No OTel settings in Settings class
6. No OTEL_* env vars in Dockerfiles

---

## 3. Implementation Summary

### 3.1 Files Created

| File | Purpose |
|------|---------|
| `src/stt_v2/core/logging.py` | `setup_logging()` with `structlog.configure()` — JSON renderer, contextvars, stdlib bridge |
| `src/stt_v2/core/telemetry.py` | `setup_telemetry()` — TracerProvider, OTLPSpanExporter, FastAPI/HTTPX auto-instrumentation |
| `src/stt_v2/core/metrics.py` | 14 custom Prometheus metrics (transcription, streaming, models, VAD, workers) |
| `src/stt_v2/core/middleware/__init__.py` | Package init |
| `src/stt_v2/core/middleware/request_id.py` | X-Request-ID extraction/generation, structlog contextvars binding |
| `src/stt_v2/core/middleware/logging.py` | Request lifecycle logging (start/complete/failed with duration_ms) |

### 3.2 Files Modified

| File | Changes |
|------|---------|
| `src/stt_v2/core/config/settings.py` | Added `otel_enabled`, `otel_exporter_endpoint`, `otel_service_name`, `metrics_enabled` fields |
| `src/stt_v2/main.py` | Wired `setup_logging()`, `RequestIDMiddleware`, `RequestLoggingMiddleware`, conditional `setup_telemetry()`, conditional Prometheus |
| `src/stt_v2/worker.py` | Wired `setup_logging()` at startup (replaced bare `structlog.get_logger`) |
| `.env.example` | Added Observability section with OTEL_ENABLED, OTEL_EXPORTER_ENDPOINT, OTEL_SERVICE_NAME, METRICS_ENABLED |
| `docker/Dockerfile` | Added OTEL_SERVICE_NAME, OTEL_EXPORTER_ENDPOINT, OTEL_ENABLED, METRICS_ENABLED env vars to runtime + ml-runtime stages |

### 3.3 Custom Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `stt_v2_transcription_total` | Counter | pipeline, engine, status | Total transcription requests |
| `stt_v2_transcription_latency_seconds` | Histogram | pipeline, engine | End-to-end latency |
| `stt_v2_transcription_errors_total` | Counter | pipeline, error_type | Error breakdown |
| `stt_v2_audio_duration_seconds` | Histogram | — | Audio file duration distribution |
| `stt_v2_streaming_sessions_active` | Gauge | — | Active streaming sessions |
| `stt_v2_streaming_sessions_total` | Counter | status | Session lifecycle |
| `stt_v2_streaming_inference_latency_seconds` | Histogram | — | Per-utterance ASR latency |
| `stt_v2_model_load_latency_seconds` | Histogram | model, engine | Model loading time |
| `stt_v2_model_cache_hits_total` | Counter | — | Cache effectiveness |
| `stt_v2_model_cache_misses_total` | Counter | — | Cold load frequency |
| `stt_v2_vad_segments_total` | Counter | — | Speech segments detected |
| `stt_v2_vad_processing_latency_seconds` | Histogram | — | VAD processing time |
| `stt_v2_worker_jobs_in_progress` | Gauge | — | Active Dramatiq jobs |
| `stt_v2_worker_jobs_total` | Counter | queue, status | Job completion tracking |

### 3.4 Environment Variables

| Variable | Default | Production |
|----------|---------|------------|
| `OTEL_ENABLED` | `false` | `true` |
| `OTEL_EXPORTER_ENDPOINT` | `http://localhost:4317` | `http://10.10.1.100:4317` |
| `OTEL_SERVICE_NAME` | `stt-v2` | `stt-v2` |
| `METRICS_ENABLED` | `true` | `true` |

### 3.5 Pattern Reference

All implementations follow the SMR gold-standard patterns:
- `core/logging.py` → `smr_v2/core/logging.py`
- `core/telemetry.py` → `smr_v2/core/telemetry.py`
- `core/middleware/request_id.py` → `smr_v2/api/middleware/request_id.py`
- `core/middleware/logging.py` → `smr_v2/api/middleware/logging.py`
- `core/metrics.py` → `smr_v2/core/metrics.py`

---

## 4. Remaining Work

### Phase 2 (Medium priority)

- [ ] Migrate 21 stdlib `logging` files to use `from stt_v2.core.logging import get_logger`
- [ ] Convert 70+ f-string log calls to structured kwargs (`error=str(e)` instead of `f"...{e}"`)
- [ ] Add `exc_info=True` to error-level exception handlers
- [ ] Instrument custom metrics into actual transcription/streaming/model code paths

### Phase 3 (Lower priority)

- [ ] Add spans to streaming session lifecycle (session_manager.py)
- [ ] Add spans to ASR inference hot path (inference.py)
- [ ] Add spans to Dramatiq worker job processing (transcribe_file.py)
- [ ] Add global exception handler to FastAPI app
- [ ] Audit and log silent `except Exception: pass` blocks

---

## 5. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-03 | Initial implementation — structured logging, OTel tracing, middleware, custom metrics, settings, Dockerfile | 6 created, 5 modified |
