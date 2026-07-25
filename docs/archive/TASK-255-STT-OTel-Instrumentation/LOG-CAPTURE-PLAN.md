# TASK-255: Complete Log Capture & Collection Plan

| Field | Value |
|-------|-------|
| **Phase** | Log capture enhancement (post initial instrumentation) |
| **Parent** | TASK-255 / TASK-251 |
| **Created** | 2026-04-03 |
| **Methodology** | TDD (Red-Green-Refactor) |
| **Goal** | Every log line from STT reaches Loki in real-time, queryable with traceId |

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State Analysis](#2-current-state-analysis)
3. [Architecture Decision](#3-architecture-decision)
4. [Gap Inventory](#4-gap-inventory)
5. [Implementation Plan](#5-implementation-plan)
6. [TDD Test List](#6-tdd-test-list)
7. [File Change Inventory](#7-file-change-inventory)
8. [Verification Criteria](#8-verification-criteria)

---

## 1. Problem Statement

Logs from STT are written to stdout as JSON but **never reach Loki**. The TASK-251 observability stack expects services to push logs via OTLP to the OTel Collector (port 4317), which routes them to Loki (port 3100). Currently:

- `structlog` → `JSONRenderer` → `sys.stdout` → **dead end**
- No `LoggerProvider` or `OTLPLogExporter` exists
- No external log scraper (Promtail/Alloy) is deployed
- 21 files use stdlib `logging` and bypass structlog entirely (plain text output)
- Uvicorn and third-party libraries produce plain text that breaks JSON parsers
- No trace context (`traceId`/`spanId`) in any log line

**Desired state**: Every log line — structlog, stdlib, uvicorn, third-party — is:
1. JSON-formatted with `traceId`, `spanId`, `requestId`, `service.name`
2. Pushed via OTLP to the OTel Collector in real-time
3. Queryable in Grafana/Loki within seconds of emission

---

## 2. Current State Analysis

### 2.1 Log Sources in STT

| Source | Files | Logger Type | Current Format | Has traceId? | Reaches Loki? |
|--------|-------|-------------|----------------|--------------|---------------|
| App code (streaming, core, API) | 18 files | `structlog.get_logger()` | JSON (after `setup_logging`) | No | No |
| App code (models, batch, VAD, storage) | 21 files | `logging.getLogger(__name__)` | Plain text `%(message)s` | No | No |
| Uvicorn access/error | 2 loggers | `logging.getLogger("uvicorn.*")` | Uvicorn's default format | No | No |
| Third-party (httpx, SQLAlchemy, dramatiq) | N/A | `logging.getLogger(...)` | Plain text | No | No |
| Dramatiq worker subprocesses | 21+ files | Mixed structlog + stdlib | Mixed JSON + plain text | No | No |

### 2.2 Reference Implementations

| Service | Approach | OTel Log Export? | Stdlib Bridge? | Trace Context? |
|---------|----------|------------------|----------------|----------------|
| **NLP** (`nlp/core/observability.py`) | Full OTel pipeline | Yes — `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor` + `LoggingHandler` on root logger | Yes — `LoggingInstrumentor` | Yes — `otelTraceID`/`otelSpanID` on log records |
| **SMR** (`smr/core/logging.py`) | structlog-only | No | No | Partial — `_add_otel_context` processor for structlog loggers only |
| **API Gateway** | Planned in TASK-252 | Planned — `OTLPLogExporter` in `instrumentation.ts` | N/A (NestJS) | Planned |

**NLP is the gold standard for log capture** — it has the complete pipeline. SMR has trace context injection for structlog loggers but no OTLP export and no stdlib bridge.

### 2.3 NLP Log Pipeline Architecture (Reference)

```
┌─────────────────────────────────────────────────────────────────────┐
│ NLP Service Process                                                │
│                                                                     │
│  structlog.get_logger() ──→ JsonFormatter ──→ stdout (JSON)         │
│                                                                     │
│  logging.getLogger() ──┬──→ StreamHandler ──→ stdout (JSON)         │
│                        │                                            │
│                        └──→ LoggingHandler ──→ LoggerProvider        │
│                                                ├──→ BatchLogRecordProcessor
│                                                └──→ OTLPLogExporter  │
│                                                     │               │
│  LoggingInstrumentor ──→ injects otelTraceID/       │               │
│                          otelSpanID into all        │               │
│                          stdlib log records          │               │
└─────────────────────────────────────────────────────┼───────────────┘
                                                      │ OTLP gRPC
                                                      ▼
                                            OTel Collector :4317
                                                      │
                                                      ▼
                                               Loki :3100
```

---

## 3. Architecture Decision

### Decision: Hybrid approach (OTLP push + stdlib bridge + structlog trace context)

Combine the NLP pattern (OTLP log export) with the SMR pattern (structlog `_add_otel_context` processor):

1. **OTLP Log Export** (NLP pattern): Add `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor` + `LoggingHandler` on root logger. This pushes all stdlib-compatible log records to the OTel Collector via OTLP gRPC.

2. **`LoggingInstrumentor`** (NLP pattern): Wire `opentelemetry.instrumentation.logging.LoggingInstrumentor` to auto-inject `otelTraceID`/`otelSpanID` into every stdlib log record.

3. **structlog `_add_otel_context` processor** (SMR pattern): Add the processor to the structlog pipeline so structlog-originated logs also contain `traceId`/`spanId` before being rendered to JSON.

4. **`ProcessorFormatter` on root handler** (new): Replace `logging.basicConfig(format="%(message)s")` with a `structlog.stdlib.ProcessorFormatter` so that **all** stdlib loggers (21 app files + uvicorn + third-party) flow through the structlog processor pipeline and produce JSON output on stdout.

5. **Uvicorn log override**: Pass `log_config=None` to `uvicorn.run()` and set `UVICORN_LOG_CONFIG=""` in Dockerfile to disable uvicorn's built-in log formatters, letting the root handler's `ProcessorFormatter` format uvicorn logs as JSON.

### Why Not Log Scraping (Promtail/Alloy)?

- TASK-251 architecture is push-based — OTel Collector is the single gateway
- Adding a scraping agent introduces another deployment dependency on VM 200
- App-level OTLP push gives structured metadata (resource attributes, trace context) without regex extraction
- Real-time delivery — OTLP push is immediate, scraping has polling intervals

### Data Flow After Fix

```
                            ┌────────────────────────┐
                            │ STT Process          │
                            │                        │
structlog.get_logger()  ────┤  _add_otel_context     │
                            │  JSONRenderer          │
                            │       │                │
                            │       ▼ stdout (JSON   │
                            │         with traceId)  │
                            │                        │
logging.getLogger() ────────┤  LoggingInstrumentor   │
  (21 app files,            │  (injects traceId)     │
   uvicorn, httpx,          │       │                │
   SQLAlchemy, dramatiq)    │       ├──→ ProcessorFormatter ──→ stdout (JSON)
                            │       │                │
                            │       └──→ LoggingHandler ──→ LoggerProvider
                            │                             ──→ BatchLogRecordProcessor
                            │                             ──→ OTLPLogExporter
                            │                                  │
                            └──────────────────────────────────┼──────┘
                                                               │ OTLP gRPC
                                                               ▼
                                                     OTel Collector :4317
                                                               │
                                                               ▼
                                                        Loki :3100
                                                               │
                                                               ▼
                                                     Grafana (real-time query)
```

---

## 4. Gap Inventory

| # | Gap | Severity | Fix Module | TDD? |
|---|-----|----------|-----------|------|
| **G1** | No `LoggerProvider` / `OTLPLogExporter` — logs never reach OTel Collector | CRITICAL | `core/telemetry.py` | Yes |
| **G2** | `LoggingInstrumentor` not wired — no traceId/spanId in stdlib logs | HIGH | `core/telemetry.py` | Yes |
| **G3** | No `_add_otel_context` processor — no traceId/spanId in structlog logs | HIGH | `core/logging.py` | Yes |
| **G4** | No `ProcessorFormatter` — stdlib loggers produce plain text, not JSON | HIGH | `core/logging.py` | Yes |
| **G5** | Uvicorn uses default log config — produces non-JSON plain text | HIGH | `main.py` + Dockerfile | Yes |
| **G6** | 21 files use `logging.getLogger(__name__)` — bypass structlog | MEDIUM | No code change needed (G4 fixes this via ProcessorFormatter) | N/A |
| **G7** | Third-party libs produce plain text | MEDIUM | No code change needed (G4 fixes this via ProcessorFormatter) | N/A |
| **G8** | Worker subprocesses need log pipeline setup | MEDIUM | `worker.py` | Yes |
| **G9** | Graceful shutdown of LoggerProvider (flush pending logs) | LOW | `main.py` lifespan teardown | Yes |

---

## 5. Implementation Plan

### Order of Implementation

The work is organized into 4 units, each following TDD Red-Green-Refactor:

### Unit 1: structlog `_add_otel_context` Processor (G3)

**Purpose**: Inject `traceId`/`spanId` into structlog-originated log entries when OTel is active.

**File to modify**: `apps/stt/src/stt/core/logging.py`

**Changes**:
- Add `_add_otel_context()` processor function (follows SMR pattern exactly)
- Insert it into the structlog processor chain (after `merge_contextvars`, before `filter_by_level`)

**Behavior**:
- When OTel is active and a span is current: adds `traceId` (32-hex) and `spanId` (16-hex)
- When OTel is not active or no span: no-op (logs stay clean)
- When `opentelemetry` is not installed: no-op (lazy import with `except Exception: pass`)

**TDD tests**:
1. `test_add_otel_context_injects_trace_ids_when_span_active`
2. `test_add_otel_context_skips_when_no_active_span`
3. `test_add_otel_context_skips_when_otel_not_installed`

---

### Unit 2: `ProcessorFormatter` for stdlib Bridge (G4, G5, G6, G7)

**Purpose**: Route ALL stdlib loggers (21 app files, uvicorn, httpx, SQLAlchemy, dramatiq) through the structlog processor pipeline so they produce JSON output.

**File to modify**: `apps/stt/src/stt/core/logging.py`

**Changes**:
- Replace `logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)` with:
  - Create a `structlog.stdlib.ProcessorFormatter` that runs the same processor chain
  - Create a `logging.StreamHandler(sys.stdout)` with that formatter
  - Set it as the root logger's handler

**Behavior**:
- Any stdlib logger (`logging.getLogger("anything")`) will produce JSON on stdout
- The JSON includes all structlog processors: timestamp, log level, logger name, OTel context
- Uvicorn access logs, SQLAlchemy query logs, httpx request logs — all become JSON
- Structlog loggers still work identically (they go through the same pipeline)

**Additional changes in `main.py`**:
- Pass `log_config=None` to `uvicorn.run()` to disable uvicorn's default log formatters

**Additional changes in Dockerfile**:
- No change needed — `log_config=None` in code is sufficient

**TDD tests**:
1. `test_stdlib_logger_produces_json_after_setup`
2. `test_stdlib_logger_includes_timestamp_and_level`
3. `test_stdlib_logger_includes_otel_context_when_span_active`
4. `test_structlog_logger_still_produces_json_after_setup`
5. `test_uvicorn_logger_produces_json_when_log_config_disabled`

---

### Unit 3: OTLP Log Export Pipeline (G1, G2, G9)

**Purpose**: Push all logs to the OTel Collector via OTLP gRPC so they reach Loki.

**File to modify**: `apps/stt/src/stt/core/telemetry.py`

**Changes**:
- Add `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor`
- Add `LoggingHandler(logger_provider=...)` on the root logger
- Wire `LoggingInstrumentor().instrument()` for automatic traceId/spanId injection
- Return `logger_provider` for graceful shutdown
- The OTLP pipeline is conditional on `otel_enabled` (same as tracing)

**File to modify**: `apps/stt/src/stt/main.py`

**Changes**:
- Store `logger_provider` on `app.state` for shutdown
- In lifespan teardown: call `logger_provider.force_flush()` then `logger_provider.shutdown()`

**Behavior**:
- Every `logging.getLogger().info(...)` call generates a log record
- The `LoggingHandler` converts it to an OTel `LogRecord` and submits to `BatchLogRecordProcessor`
- `BatchLogRecordProcessor` batches records and sends via `OTLPLogExporter` to the collector
- `LoggingInstrumentor` injects `otelTraceID`, `otelSpanID`, `otelServiceName` into every stdlib log record
- On shutdown, `force_flush()` ensures pending logs are sent before the process exits

**TDD tests**:
1. `test_setup_telemetry_creates_logger_provider_when_enabled`
2. `test_setup_telemetry_adds_logging_handler_to_root_logger`
3. `test_setup_telemetry_instruments_logging_for_trace_context`
4. `test_setup_telemetry_skips_log_pipeline_when_disabled`
5. `test_setup_telemetry_returns_logger_provider_for_shutdown`
6. `test_logger_provider_shutdown_flushes_pending_logs`

---

### Unit 4: Worker Subprocess Log Pipeline (G8)

**Purpose**: Ensure Dramatiq worker subprocesses also push logs via OTLP.

**File to modify**: `apps/stt/src/stt/worker.py`

**Changes**:
- After `setup_logging()`, conditionally call a new `setup_worker_telemetry()` function
- This sets up `LoggerProvider` + `OTLPLogExporter` (same as Unit 3, but without FastAPI instrumentation)
- Register an `atexit` handler or Dramatiq middleware to flush/shutdown the LoggerProvider

**Note**: The worker does NOT need `FastAPIInstrumentor` or `HTTPXClientInstrumentor` since it doesn't handle HTTP requests. It only needs the log export pipeline.

**TDD tests**:
1. `test_worker_setup_logging_produces_json`
2. `test_worker_creates_log_pipeline_when_otel_enabled`
3. `test_worker_skips_log_pipeline_when_otel_disabled`

---

## 6. TDD Test List

All tests will live in `apps/stt/tests/unit/test_observability.py`.

### Unit 1: `_add_otel_context` Processor

| # | Test | Behavior | Expected |
|---|------|----------|----------|
| 1.1 | `test_add_otel_context_injects_trace_ids_when_span_active` | Call processor with active OTel span | `event_dict` has `traceId` (32 hex chars) and `spanId` (16 hex chars) |
| 1.2 | `test_add_otel_context_skips_when_no_active_span` | Call processor with INVALID_SPAN (trace_id=0) | `event_dict` unchanged (no `traceId`/`spanId` keys) |
| 1.3 | `test_add_otel_context_skips_when_otel_not_installed` | Call processor when `opentelemetry.trace` import fails | `event_dict` unchanged, no exception raised |

### Unit 2: `ProcessorFormatter` stdlib Bridge

| # | Test | Behavior | Expected |
|---|------|----------|----------|
| 2.1 | `test_stdlib_logger_produces_json_after_setup` | `logging.getLogger("test").info("hello")` after `setup_logging()` | Captured stdout is valid JSON with `"event": "hello"` |
| 2.2 | `test_stdlib_logger_includes_timestamp_and_level` | Same as 2.1 | JSON has `"timestamp"` (ISO format) and `"level": "info"` |
| 2.3 | `test_stdlib_logger_includes_otel_context_when_span_active` | Emit stdlib log inside an active OTel span | JSON has `"traceId"` and `"spanId"` |
| 2.4 | `test_structlog_logger_still_produces_json` | `get_logger("test").info("hello")` after `setup_logging()` | Captured stdout is valid JSON with `"event": "hello"` |
| 2.5 | `test_contextvars_visible_in_stdlib_logs` | Bind `request_id` via `structlog.contextvars.bind_contextvars`, emit stdlib log | JSON has `"request_id"` |

### Unit 3: OTLP Log Export Pipeline

| # | Test | Behavior | Expected |
|---|------|----------|----------|
| 3.1 | `test_setup_telemetry_creates_logger_provider` | Call `setup_telemetry()` with `otel_enabled=True` | Returns a result containing a `LoggerProvider` instance |
| 3.2 | `test_setup_telemetry_adds_logging_handler_to_root` | Call `setup_telemetry()` | Root logger has at least one `LoggingHandler` |
| 3.3 | `test_setup_telemetry_instruments_logging` | Call `setup_telemetry()` | `LoggingInstrumentor` is instrumented (check via `is_instrumented()`) |
| 3.4 | `test_setup_telemetry_skips_logs_when_disabled` | Call `setup_telemetry()` with `otel_enabled=False` | No `LoggingHandler` on root logger, no `LoggerProvider` |
| 3.5 | `test_logger_provider_shutdown_calls_flush` | Shutdown the returned `LoggerProvider` | `force_flush()` called before `shutdown()` |
| 3.6 | `test_log_records_include_resource_attributes` | Emit log, inspect OTel `LogRecord` | Resource has `service.name=stt`, `service.namespace=hope` |

### Unit 4: Worker Subprocess Log Pipeline

| # | Test | Behavior | Expected |
|---|------|----------|----------|
| 4.1 | `test_worker_setup_logging_produces_json` | Call `setup_logging()` at module level, emit log | JSON on stdout |
| 4.2 | `test_worker_log_pipeline_created_when_enabled` | Call `setup_worker_telemetry()` with `otel_enabled=True` | `LoggerProvider` created, `LoggingHandler` on root |
| 4.3 | `test_worker_log_pipeline_skipped_when_disabled` | Call `setup_worker_telemetry()` with `otel_enabled=False` | No `LoggerProvider` |

### Edge Cases & Error Handling

| # | Test | Behavior | Expected |
|---|------|----------|----------|
| E.1 | `test_otel_context_processor_handles_exception_gracefully` | Force `trace.get_current_span()` to raise | `event_dict` returned unchanged, no exception |
| E.2 | `test_setup_logging_idempotent` | Call `setup_logging()` twice | No duplicate handlers on root logger |
| E.3 | `test_otlp_exporter_failure_does_not_crash_logging` | OTel collector unreachable, emit log | Log still appears on stdout (OTLP failure is non-blocking) |

**Total: 20 tests**

---

## 7. File Change Inventory

### Files to Modify

| File | Unit | Changes |
|------|------|---------|
| `src/stt/core/logging.py` | 1, 2 | Add `_add_otel_context` processor; replace `logging.basicConfig` with `ProcessorFormatter`; add processor to structlog chain |
| `src/stt/core/telemetry.py` | 3 | Add `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor` + `LoggingHandler`; wire `LoggingInstrumentor`; return `logger_provider` |
| `src/stt/main.py` | 3, 2 | Store `logger_provider` on `app.state`; flush/shutdown in lifespan teardown; pass `log_config=None` to `uvicorn.run()` |
| `src/stt/worker.py` | 4 | Add conditional `setup_worker_telemetry()` call after `setup_logging()` |

### Files to Create

| File | Unit | Purpose |
|------|------|---------|
| `tests/unit/test_observability.py` | All | 20 TDD tests for logging, trace context, OTLP export, stdlib bridge |

### Files NOT Changed (Gaps Fixed Automatically)

The following 21 stdlib-logging files do **NOT** need modification — the `ProcessorFormatter` on the root handler (Unit 2) automatically formats their output as JSON:

| File | Why No Change Needed |
|------|---------------------|
| `models/huggingface_loader.py` | `logging.getLogger(__name__)` → root handler → `ProcessorFormatter` → JSON |
| `models/onnx_loader.py` | Same |
| `models/nemo_loader.py` | Same |
| `models/cache.py` | Same |
| `models/base_loader.py` | Same |
| `models/azure_speech_loader.py` | Same |
| `transcription/batch_service.py` | Same |
| `transcription/preprocessing.py` | Same |
| `transcription/segment_merger.py` | Same |
| `transcription/workers/transcribe_file.py` | Same |
| `vad/silero_service.py` | Same |
| `vad/session_manager.py` | Same |
| `storage/blob_service.py` | Same |
| `storage/path_resolver.py` | Same |
| `pipeline/yaml_parser.py` | Same |
| `pipeline/config_reader.py` | Same |
| `embedding/api/routes.py` | Same |
| `diarization/embedding_service.py` | Same |
| `diarization/speaker_identifier.py` | Same |
| `core/vectorstore/speaker_store.py` | Same |
| `core/vectorstore/client.py` | Same |

---

## 8. Verification Criteria

### Local Verification (before deployment)

| Check | Command | Expected |
|-------|---------|----------|
| All 20 tests pass | `conda run -n arcaenv pytest tests/unit/test_observability.py -v` | 20 passed |
| Existing tests still pass | `conda run -n arcaenv pytest tests/unit/ -v --tb=short -m "not slow"` | All pass, no regressions |
| No lint errors | `ruff check src/stt/core/logging.py src/stt/core/telemetry.py` | Clean |
| stdout is JSON | `OTEL_ENABLED=false python -c "from stt.core.logging import setup_logging; setup_logging(); import logging; logging.getLogger('test').info('hello')"` | Valid JSON line |

### Production Verification (after deployment)

| Check | Method | Expected |
|-------|--------|----------|
| Prometheus: stt target UP | `curl localhost:9090/api/v1/targets \| grep stt` | `health: up` |
| Loki: STT logs appear | `curl 'localhost:3100/loki/api/v1/query?query={service_name="stt"}&limit=5'` | Log entries with JSON body |
| Loki: traceId present | Same query, inspect log fields | `traceId` and `spanId` in log entries |
| Loki: requestId present | Same query, inspect log fields | `request_id` in log entries |
| Tempo: traces correlate | Click traceId in Loki → opens Tempo trace | Linked spans visible |
| Latency: < 5s | Emit log → query in Grafana | Log appears within 5 seconds |
| No stdout gap | `docker logs stt \| python -c "import sys,json; [json.loads(l) for l in sys.stdin]"` | All lines are valid JSON |
| Worker logs in Loki | `curl 'localhost:3100/loki/api/v1/query?query={service_name="stt"} \|= "worker"&limit=5'` | Worker log entries present |
| Graceful shutdown | Stop container, check Loki | Last log entries include "shutdown" messages |

---

## 9. Execution Order (TDD Cycle)

```
Unit 1: _add_otel_context processor
  RED  → test_add_otel_context_injects_trace_ids_when_span_active (FAIL)
  GREEN → implement _add_otel_context in logging.py
  RED  → test_add_otel_context_skips_when_no_active_span (FAIL)
  GREEN → verify no-op path
  RED  → test_add_otel_context_skips_when_otel_not_installed (FAIL)
  GREEN → verify try/except path
  REFACTOR

Unit 2: ProcessorFormatter stdlib bridge
  RED  → test_stdlib_logger_produces_json_after_setup (FAIL)
  GREEN → replace basicConfig with ProcessorFormatter
  RED  → test_stdlib_logger_includes_timestamp_and_level (FAIL)
  GREEN → verify processor chain inclusion
  RED  → test_structlog_logger_still_produces_json (FAIL)
  GREEN → verify no regression
  RED  → test_contextvars_visible_in_stdlib_logs (FAIL)
  GREEN → verify merge_contextvars works for stdlib
  REFACTOR

Unit 3: OTLP log export
  RED  → test_setup_telemetry_creates_logger_provider (FAIL)
  GREEN → add LoggerProvider to setup_telemetry
  RED  → test_setup_telemetry_adds_logging_handler_to_root (FAIL)
  GREEN → add LoggingHandler
  RED  → test_setup_telemetry_instruments_logging (FAIL)
  GREEN → wire LoggingInstrumentor
  RED  → test_setup_telemetry_skips_logs_when_disabled (FAIL)
  GREEN → verify conditional path
  REFACTOR

Unit 4: Worker subprocess pipeline
  RED  → test_worker_log_pipeline_created_when_enabled (FAIL)
  GREEN → add setup_worker_telemetry
  RED  → test_worker_log_pipeline_skipped_when_disabled (FAIL)
  GREEN → verify conditional path
  REFACTOR

Edge cases:
  RED  → test_otel_context_processor_handles_exception_gracefully (FAIL)
  GREEN → verify try/except
  RED  → test_setup_logging_idempotent (FAIL)
  GREEN → guard against duplicate handlers
  RED  → test_otlp_exporter_failure_does_not_crash_logging (FAIL)
  GREEN → verify non-blocking OTLP
  REFACTOR → final cleanup
```

---

## 10. Dependencies

No new packages needed — all required packages are already in `pyproject.toml`:

| Package | Version | Status |
|---------|---------|--------|
| `opentelemetry-api` | `>=1.39.1` | Installed, used by telemetry.py |
| `opentelemetry-sdk` | `>=1.39.1` | Installed, used by telemetry.py |
| `opentelemetry-exporter-otlp-proto-grpc` | `>=1.39.0` | Installed, used by telemetry.py |
| `opentelemetry-instrumentation-logging` | `>=0.60b1` | Installed, **currently unused** — will be wired |
| `opentelemetry-instrumentation-fastapi` | `>=0.60b1` | Installed, used by telemetry.py |
| `opentelemetry-instrumentation-httpx` | `>=0.60b1` | Installed, used by telemetry.py |
| `structlog` | `>=25.5.0` | Installed, used by logging.py |
| `prometheus-client` | `>=0.24.1` | Installed, used by metrics.py |

The `opentelemetry-sdk` package includes `opentelemetry.sdk._logs` (LoggerProvider, LoggingHandler, BatchLogRecordProcessor) and `opentelemetry.exporter.otlp.proto.grpc._log_exporter` (OTLPLogExporter).
