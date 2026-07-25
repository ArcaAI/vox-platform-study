# TASK-255: STT OpenTelemetry Instrumentation

| Field | Value |
|-------|-------|
| **Ticket** | TASK-255 |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 |
| **Status** | Completed |
| **Type** | Infrastructure |
| **Priority** | High |
| **Parent** | TASK-251 (Observability Stack) |

---

## 1. Requirement Analysis

### 1.1 Description

Wire the STT service (`apps/stt/`) with structured logging, OpenTelemetry distributed tracing, request context propagation, and custom Prometheus metrics so it integrates with the TASK-251 observability stack (OTel Collector, Prometheus, Loki, Tempo, Grafana).

### 1.2 Business Context

- STT scored **3.5/10** in the TASK-251 service audit — the worst of all HOPE services
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
| `src/stt/core/logging.py` | `setup_logging()` with `structlog.configure()` — JSON renderer, contextvars, stdlib bridge, `_add_otel_context` processor, `ProcessorFormatter` for stdlib logs |
| `src/stt/core/telemetry.py` | `setup_telemetry()` — TracerProvider + LoggerProvider, OTLP gRPC exporters (spans + logs), FastAPI/HTTPX/Logging auto-instrumentation, `TelemetryResult` dataclass |
| `src/stt/core/metrics.py` | 14 custom Prometheus metrics (transcription, streaming, models, VAD, workers) |
| `src/stt/core/middleware/__init__.py` | Package init |
| `src/stt/core/middleware/request_id.py` | X-Request-ID extraction/generation, structlog contextvars binding |
| `src/stt/core/middleware/logging.py` | Request lifecycle logging (start/complete/failed with duration_ms) |
| `tests/unit/test_observability.py` | 20 TDD tests covering all observability layers (trace context, stdlib bridge, OTLP export, worker pipeline, edge cases) |

### 3.2 Files Modified

| File | Changes |
|------|---------|
| `src/stt/core/config/settings.py` | Added `otel_enabled`, `otel_exporter_endpoint`, `otel_service_name`, `metrics_enabled` fields |
| `src/stt/main.py` | Wired `setup_logging()`, middleware, conditional `setup_telemetry()` with `TelemetryResult` stored on `app.state`, graceful OTel shutdown in lifespan, `log_config=None` for uvicorn |
| `src/stt/worker.py` | Wired `setup_logging()`, conditional `setup_telemetry_logs()` for OTel log export, graceful shutdown of LoggerProvider |
| `.env.example` | Added Observability section with OTEL_ENABLED, OTEL_EXPORTER_ENDPOINT, OTEL_SERVICE_NAME, METRICS_ENABLED |
| `docker/Dockerfile` | Added OTEL_SERVICE_NAME, OTEL_EXPORTER_ENDPOINT, OTEL_ENABLED, METRICS_ENABLED env vars to runtime + ml-runtime stages |

### 3.3 Custom Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `stt_transcription_total` | Counter | pipeline, engine, status | Total transcription requests |
| `stt_transcription_latency_seconds` | Histogram | pipeline, engine | End-to-end latency |
| `stt_transcription_errors_total` | Counter | pipeline, error_type | Error breakdown |
| `stt_audio_duration_seconds` | Histogram | — | Audio file duration distribution |
| `stt_streaming_sessions_active` | Gauge | — | Active streaming sessions |
| `stt_streaming_sessions_total` | Counter | status | Session lifecycle |
| `stt_streaming_inference_latency_seconds` | Histogram | — | Per-utterance ASR latency |
| `stt_model_load_latency_seconds` | Histogram | model, engine | Model loading time |
| `stt_model_cache_hits_total` | Counter | — | Cache effectiveness |
| `stt_model_cache_misses_total` | Counter | — | Cold load frequency |
| `stt_vad_segments_total` | Counter | — | Speech segments detected |
| `stt_vad_processing_latency_seconds` | Histogram | — | VAD processing time |
| `stt_worker_jobs_in_progress` | Gauge | — | Active Dramatiq jobs |
| `stt_worker_jobs_total` | Counter | queue, status | Job completion tracking |

### 3.4 Environment Variables

| Variable | Default | Production |
|----------|---------|------------|
| `OTEL_ENABLED` | `false` | `true` |
| `OTEL_EXPORTER_ENDPOINT` | `http://localhost:4317` | `http://10.10.1.100:4317` |
| `OTEL_SERVICE_NAME` | `stt` | `stt` |
| `METRICS_ENABLED` | `true` | `true` |

### 3.5 Pattern Reference

All implementations follow the SMR gold-standard patterns:
- `core/logging.py` → `smr/core/logging.py`
- `core/telemetry.py` → `smr/core/telemetry.py`
- `core/middleware/request_id.py` → `smr/api/middleware/request_id.py`
- `core/middleware/logging.py` → `smr/api/middleware/logging.py`
- `core/metrics.py` → `smr/core/metrics.py`

---

## 4. Remaining Work

### Phase 2 (Medium priority)

- [ ] Migrate 21 stdlib `logging` files to use `from stt.core.logging import get_logger`
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
| 2026-04-03 | Log capture pipeline (TDD) — `_add_otel_context` processor for traceId/spanId in structlog, `ProcessorFormatter` bridge for stdlib→JSON, `LoggerProvider` + `OTLPLogExporter` for OTLP log push, `LoggingInstrumentor` for auto trace context, `setup_telemetry_logs()` for worker processes, graceful OTel shutdown, uvicorn `log_config=None` override. 20 TDD tests (all passing). | `core/logging.py`, `core/telemetry.py`, `main.py`, `worker.py`, `tests/unit/test_observability.py` |
