# TASK-257: SMR Log Collection Pipeline — OTel SDK Log Bridge

| Field | Value |
|-------|-------|
| **Ticket** | TASK-257 |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 |
| **Status** | Completed |
| **Type** | Infrastructure / Enhancement |
| **Priority** | Critical |
| **Depends On** | TASK-254 (SMR OTel Observability Hardening), TASK-251 (Observability Stack) |

---

## 1. Requirement Analysis

### 1.1 Description

Implement a complete log collection pipeline for the SMR service so that **every log line** — application logs (structlog), uvicorn access/error logs, and third-party library logs — is captured, exported via OTLP to the OpenTelemetry Collector, and forwarded to Grafana Loki for real-time/near-real-time querying.

Currently, SMR logs are only written to stdout. TASK-254 added `traceId`/`spanId` injection into structlog entries, but there is no mechanism to push these logs to the OTel Collector. The OTel Collector's logs pipeline (`otlp → Loki`) is fully configured and waiting for log data — SMR just isn't sending any.

### 1.2 Business Context

- **Blocking real-time log querying**: Ops cannot query SMR logs in Grafana Loki because no logs are being sent to the Collector
- **Trace-log correlation incomplete**: TASK-254 injected `traceId`/`spanId` into log entries, but without Loki ingestion, the Loki → Tempo click-through workflow doesn't work
- **Production debugging**: Cross-service investigations require all services to send logs to the same centralized store (Loki)
- **Log completeness**: Uvicorn and third-party library logs (httpx, boto3, openai SDK, redis) bypass structlog entirely and are emitted as unstructured plain text — these must also be captured

### 1.3 Acceptance Criteria

- [ ] `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor` configured in SMR
- [ ] `LoggingHandler` attached to Python root logger — all `logging` module output exported as OTLP log records
- [ ] `LoggingInstrumentor` injects `otelTraceID`/`otelSpanID` into stdlib `LogRecord` objects
- [ ] structlog logs (which delegate to stdlib `logging`) are exported via OTLP
- [ ] Uvicorn logs are captured by the OTel bridge (propagate set to True, or uvicorn access logs disabled since `RequestLoggingMiddleware` already covers access logging)
- [ ] Third-party library logs (httpx, boto3, openai, redis) are captured by the OTel bridge
- [ ] `LoggerProvider` shut down gracefully in lifespan teardown (alongside `TracerProvider`)
- [ ] Log export is conditional on `otel_enabled` setting (no OTLP export when disabled)
- [ ] stdout logging preserved (dual-path: stdout for container logs + OTLP for Loki)
- [ ] PHI sanitization hook strips sensitive attributes from FastAPI instrumentation spans
- [ ] Health/docs endpoints excluded from FastAPI instrumentation (no noise traces)
- [ ] All changes covered by tests (TDD — Red/Green/Refactor)
- [ ] All existing 697+ tests pass
- [ ] No new linter errors
- [ ] `opentelemetry-instrumentation-logging` dependency added to `pyproject.toml`

---

## 2. Current State Evaluation

### 2.1 What Already Works (from TASK-254)

| Area | Status | Details |
|------|--------|---------|
| structlog JSON output | Working | JSON renderer + contextvar merging + request ID propagation |
| Trace context in logs | Working | `_add_otel_context` processor injects `traceId`/`spanId` into structlog entries |
| TracerProvider | Working | Configurable endpoint, service attributes, graceful shutdown |
| Prometheus metrics | Working | 14 custom metrics, FastAPI instrumentator |
| OTel Collector logs pipeline | Ready | `otlp → memory_limiter → resource → batch → otlphttp/loki` configured |

### 2.2 What Is Missing

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| 1 | **No `LoggerProvider`** — SMR has no OTel log export capability | CRITICAL | Zero logs reach the OTel Collector/Loki |
| 2 | **No `LoggingHandler`** on root logger — stdlib `logging` output not bridged to OTLP | CRITICAL | Even if LoggerProvider existed, no log records would flow through it |
| 3 | **No `LoggingInstrumentor`** — stdlib LogRecords lack `otelTraceID`/`otelSpanID` fields | HIGH | Third-party logs can't be correlated with traces |
| 4 | **No `opentelemetry-instrumentation-logging` dependency** | HIGH | Can't import `LoggingInstrumentor` |
| 5 | **Uvicorn loggers bypass structlog** — `uvicorn.error` and `uvicorn.access` use own formatters with `propagate=False` | HIGH | Uvicorn logs not captured by any bridge |
| 6 | **Uvicorn access logs duplicate** `RequestLoggingMiddleware` — every request generates 2 access log entries | MEDIUM | Log noise, double storage cost in Loki |
| 7 | **No PHI sanitization hook** on `FastAPIInstrumentor` | MEDIUM | Request/response bodies could leak PHI into trace spans |
| 8 | **Health/docs URLs not excluded** from `FastAPIInstrumentor` | MEDIUM | Noisy health-check traces pollute Tempo |
| 9 | **No `LoggerProvider` shutdown** in lifespan teardown | HIGH | Buffered logs lost on graceful shutdown |

### 2.3 Log Source Inventory (19 emission paths)

The following table documents every log source in the SMR app. Understanding this is critical to ensuring complete capture.

#### Application Logs (via structlog → structlog pipeline → captured by root logger)

| # | Source File | Logger Name | Levels | Has traceId? | Output |
|---|-------------|-------------|--------|--------------|--------|
| 1 | `main.py` | `smr.main` | INFO, WARN, ERROR | Yes | stdout JSON |
| 2 | `middleware/logging.py` | `smr.access` | INFO, ERROR | Yes | stdout JSON |
| 3 | `middleware/auth.py` | `smr.api.middleware.auth` | WARN | Yes | stdout JSON |
| 4 | `endpoints/generate.py` | `smr.api.endpoints.generate` | WARN, ERROR | Yes | stdout JSON |
| 5 | `services/audit.py` | `smr.services.audit` | INFO, WARN, ERROR | Yes | stdout JSON |
| 6 | `services/generation_audit.py` | `smr.audit.generation` | INFO, ERROR | Yes | stdout JSON |
| 7 | `services/shutdown_manager.py` | `smr.services.shutdown_manager` | WARN | Yes | stdout JSON |
| 8 | `providers/ollama.py` | `smr.providers.ollama` | WARN, ERROR | Yes | stdout JSON |
| 9 | `providers/azure_openai.py` | `smr.providers.azure_openai` | WARN, ERROR | Yes | stdout JSON |
| 10 | `providers/bedrock.py` | `smr.providers.bedrock` | WARN, ERROR | Yes | stdout JSON |
| 11 | `providers/openai_compat.py` | `smr.providers.openai_compat` | WARN, ERROR | Yes | stdout JSON |

#### Third-Party Logs (via stdlib `logging` — NOT through structlog)

| # | Library | Logger Name | Goes Through structlog? | Has traceId? | Format |
|---|---------|-------------|-------------------------|--------------|--------|
| 12 | uvicorn | `uvicorn.error` | NO | NO | Plain text |
| 13 | uvicorn | `uvicorn.access` | NO | NO | Plain text |
| 14 | httpx | `httpx` | NO | NO | Plain text |
| 15 | openai SDK | `openai` | NO | NO | Plain text |
| 16 | boto3/botocore | `botocore` | NO | NO | Plain text |
| 17 | redis | `redis` | NO | NO | Plain text |
| 18 | opentelemetry | `opentelemetry.*` | NO | NO | Plain text |
| 19 | Unhandled exceptions | Uvicorn handler | NO | NO | stderr plain |

### 2.4 Reference Implementation (NLP Service)

The NLP service (`apps/nlp/src/nlp/core/observability.py`) already has a fully working OTel log bridge:

```1:18:apps/nlp/src/nlp/core/observability.py
import logging
// ... imports ...
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
// ... more imports ...
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
```

Key operations in the NLP reference:
1. Creates `OTLPLogExporter` → `BatchLogRecordProcessor` → `LoggerProvider` (lines 77-80)
2. Attaches `LoggingHandler` to Python root logger (lines 83-84)
3. Calls `LoggingInstrumentor().instrument(set_logging_format=False)` (lines 107-111)
4. Shuts down `LoggerProvider` in teardown (lines 127-128)
5. Uninstruments `LoggingInstrumentor` and `FastAPIInstrumentor` (lines 130-134)
6. Excludes health/docs/metrics URLs from `FastAPIInstrumentor` (lines 86-94)
7. Adds PHI sanitization hook to `FastAPIInstrumentor` (lines 26-30, 98)

### 2.5 OTel Collector Pipeline (Already Configured)

The Collector at `otel-collector-config.yaml` receives OTLP logs on `:4317` (gRPC) and routes them to Loki:

```91:95:docs/implementation/TASK-251-Observability-Stack/configs/otel/otel-collector-config.yaml
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp/loki]
```

SMR just needs to send OTLP log records to this receiver.

---

## 3. Implementation Plan

### Architecture: Dual-Path Logging

```
  structlog loggers ──→ structlog pipeline ──→ stdlib logging.Logger
                            │                          │
                            │ (_add_otel_context        │
                            │  injects traceId/spanId)  │
                            │                          │
                            ▼                          ▼
                    JSONRenderer output ──→ StreamHandler ──→ stdout (container logs)
                                                       │
                                           LoggingHandler ──→ BatchLogRecordProcessor
                                                                      │
                                                              OTLPLogExporter
                                                                      │
                                                              OTel Collector :4317
                                                                      │
                                                              otlphttp/loki
                                                                      │
                                                              Grafana Loki
```

Both paths coexist:
- **stdout path** (existing): For Docker/K8s container log aggregation, local development
- **OTLP path** (new): For Grafana Loki with full trace correlation and real-time querying

### Task Breakdown

---

#### Task 1 — Add `opentelemetry-instrumentation-logging` Dependency

**File**: `apps/smr/pyproject.toml`

Add `opentelemetry-instrumentation-logging>=0.60b1` to the `dependencies` list. This package provides `LoggingInstrumentor` which injects `otelTraceID`/`otelSpanID` into Python `logging.LogRecord` objects and can auto-install the `LoggingHandler`.

**Tests**: No code tests needed — this is a pure dependency addition. Verify the package installs correctly.

**Verification**: `python -c "from opentelemetry.instrumentation.logging import LoggingInstrumentor; print('OK')"`

---

#### Task 2 — Refactor `telemetry.py` → `observability.py` with Full OTel Log Bridge

**File**: `apps/smr/src/smr/core/telemetry.py` (rename to `observability.py`)

Replace the current traces-only `setup_telemetry()` with a comprehensive `setup_opentelemetry()` that configures:

1. **Shared `Resource`** with SDK constants (`SERVICE_NAME`, `SERVICE_VERSION`, `TELEMETRY_SDK_LANGUAGE`, `DEPLOYMENT_ENVIRONMENT`)
2. **`TracerProvider`** with `BatchSpanProcessor` + `OTLPSpanExporter` (existing, moved)
3. **`LoggerProvider`** with `BatchLogRecordProcessor` + `OTLPLogExporter` (NEW)
4. **`LoggingHandler`** attached to Python root logger at `logging.DEBUG` level (NEW)
5. **`FastAPIInstrumentor`** with PHI sanitization hook and excluded URLs (ENHANCED)
6. **`HTTPXClientInstrumentor`** (existing, moved)
7. **`LoggingInstrumentor`** with `set_logging_format=False` (NEW)
8. **`get_tracer()`** helper (existing, preserved)

Also create `shutdown_opentelemetry()`:
1. Shut down `TracerProvider`, `LoggerProvider`
2. Uninstrument `LoggingInstrumentor` and `FastAPIInstrumentor`

**Why rename**: The module now manages traces + logs + instrumentation — "telemetry" (traces-only) is misleading. "observability" matches the NLP reference and the broader scope.

**Tests (TDD)**:

| Test | Behavior | Expected |
|------|----------|----------|
| `test_setup_creates_logger_provider` | After `setup_opentelemetry()`, `app.state.logger_provider` is set | `LoggerProvider` instance stored |
| `test_setup_adds_logging_handler_to_root` | After setup, root logger has a `LoggingHandler` | `any(isinstance(h, LoggingHandler) for h in logging.getLogger().handlers)` |
| `test_setup_calls_logging_instrumentor` | `LoggingInstrumentor().instrument()` is called | Mock verifies call |
| `test_setup_excludes_health_urls_from_fastapi` | `FastAPIInstrumentor` receives `excluded_urls` with health endpoints | Mock verifies kwargs |
| `test_setup_adds_phi_hook_to_fastapi` | `FastAPIInstrumentor` receives `server_request_hook` | Mock verifies PHI sanitization hook passed |
| `test_shutdown_stops_logger_provider` | `shutdown_opentelemetry()` calls `logger_provider.shutdown()` | Mock verifies call |
| `test_shutdown_uninstruments_logging` | `shutdown_opentelemetry()` calls `LoggingInstrumentor().uninstrument()` | Mock verifies call |
| `test_phi_hook_redacts_body_attributes` | PHI hook sets `http.request.body` and `http.response.body` to `[REDACTED]` | Span attributes assert |
| `test_setup_preserves_tracer_provider` | `app.state.tracer_provider` still set after refactor | `TracerProvider` instance stored |
| `test_resource_has_sdk_constants` | Resource uses OTel SDK constants, not string literals | Resource attributes include `telemetry.sdk.language` |
| `test_get_tracer_still_works` | `get_tracer()` returns valid tracer after refactor | Has `start_as_current_span` |
| `test_setup_noop_when_disabled` | When `otel_enabled=False`, no providers are created | app.state providers are None |

---

#### Task 3 — Add `otel_logs_enabled` Setting to Config

**File**: `apps/smr/src/smr/core/config.py`

Add a granular `otel_logs_enabled: bool = True` field to `Settings`. When `otel_enabled=True` but `otel_logs_enabled=False`, traces are exported but logs are not. This allows operators to enable observability incrementally.

**Tests (TDD)**:

| Test | Behavior | Expected |
|------|----------|----------|
| `test_otel_logs_enabled_default_true` | `Settings().otel_logs_enabled` defaults to `True` | `assert settings.otel_logs_enabled is True` |
| `test_otel_logs_enabled_from_env` | `SMR_OTEL_LOGS_ENABLED=false` sets field | `assert settings.otel_logs_enabled is False` |

---

#### Task 4 — Update `main.py` Lifespan and `create_app`

**File**: `apps/smr/src/smr/main.py`

1. Replace `from smr.core.telemetry import setup_telemetry` with `from smr.core.observability import setup_opentelemetry, shutdown_opentelemetry`
2. Call `setup_opentelemetry(app, settings)` instead of `setup_telemetry(app, ...)` in `create_app()`
3. Initialize `app.state.logger_provider = None`
4. In lifespan teardown, call `shutdown_opentelemetry(app)` (replacing the manual `tracer_provider.force_flush()/shutdown()` block)

**Tests (TDD)**:

| Test | Behavior | Expected |
|------|----------|----------|
| `test_create_app_initializes_logger_provider_state` | `create_app()` sets `app.state.logger_provider` | Attribute exists, is None when disabled |
| `test_create_app_calls_setup_opentelemetry_when_enabled` | When `otel_enabled=True`, `setup_opentelemetry` is called | Mock verifies |
| `test_create_app_skips_setup_when_disabled` | When `otel_enabled=False`, `setup_opentelemetry` is NOT called | Mock not called |
| `test_lifespan_teardown_calls_shutdown` | Lifespan teardown calls `shutdown_opentelemetry(app)` | Mock verifies |

---

#### Task 5 — Tame Uvicorn Logging (Disable Duplicate Access Logs)

**File**: `apps/smr/src/smr/core/logging.py`

Currently, uvicorn emits access logs that duplicate `RequestLoggingMiddleware`. Two fixes:

1. **Disable uvicorn access log** — SMR's `RequestLoggingMiddleware` already logs every request as structured JSON with `traceId`, `spanId`, `request_id`, `status_code`, `duration_ms`. Uvicorn's access log is redundant and unstructured.
2. **Set uvicorn loggers to propagate** — `uvicorn.error` logs (startup, shutdown, uncaught exceptions) should propagate to the root logger so the OTel `LoggingHandler` captures them.

Add a `configure_uvicorn_logging()` function:
```python
def configure_uvicorn_logging():
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.error").handlers = []
    logging.getLogger("uvicorn.error").propagate = True
```

Call this from `setup_logging()`.

**Tests (TDD)**:

| Test | Behavior | Expected |
|------|----------|----------|
| `test_uvicorn_access_disabled` | After `setup_logging()`, `uvicorn.access` is disabled | `logging.getLogger("uvicorn.access").disabled is True` |
| `test_uvicorn_error_propagates` | After `setup_logging()`, `uvicorn.error` propagates to root | `logging.getLogger("uvicorn.error").propagate is True` |
| `test_uvicorn_error_no_own_handlers` | After `setup_logging()`, `uvicorn.error` has no direct handlers | `len(logging.getLogger("uvicorn.error").handlers) == 0` |

---

#### Task 6 — Update `.env.example` and Dockerfile

**Files**: `apps/smr/.env.example`, `apps/smr/Dockerfile`

1. Add `SMR_OTEL_LOGS_ENABLED=true` to `.env.example` with documentation
2. Add `ENV SMR_OTEL_LOGS_ENABLED=true` to Dockerfile production stage

**Tests**: No code tests — pure configuration. Manual verification.

---

#### Task 7 — Update Existing Test Imports

**Files**: All test files that import from `smr.core.telemetry`

After renaming `telemetry.py` → `observability.py`, update imports in:
- `test_telemetry.py` — rename to `test_observability.py`, update imports
- Any test that patches `smr.core.telemetry.setup_telemetry`

The `get_tracer()` function must remain importable from the new location. Optionally add a compatibility re-export in `telemetry.py` if other code imports from it.

**Tests**: Existing tests should pass after import path updates.

---

### Task Dependency Order

```
Task 1 (dependency) → Task 2 (observability.py) → Task 3 (config) → Task 4 (main.py) → Task 5 (uvicorn logging) → Task 6 (.env/Dockerfile) → Task 7 (test imports)
```

Tasks 3, 5 are independent of each other but both depend on Task 2 being designed.

---

## 4. Files to Create

| File | Purpose |
|------|---------|
| `apps/smr/src/smr/core/observability.py` | New consolidated OTel setup (replaces `telemetry.py`) |
| `apps/smr/src/smr/tests/unit/test_log_pipeline.py` | TDD tests for the log bridge |

## 5. Files to Modify

| File | Changes |
|------|---------|
| `apps/smr/pyproject.toml` | Add `opentelemetry-instrumentation-logging>=0.60b1` |
| `apps/smr/src/smr/core/config.py` | Add `otel_logs_enabled` field |
| `apps/smr/src/smr/core/logging.py` | Add `configure_uvicorn_logging()`, call from `setup_logging()` |
| `apps/smr/src/smr/main.py` | Replace `setup_telemetry` call with `setup_opentelemetry`/`shutdown_opentelemetry`; init `logger_provider` state |
| `apps/smr/src/smr/core/telemetry.py` | Keep as thin compatibility shim (re-exports `get_tracer` from `observability.py`) |
| `apps/smr/.env.example` | Add `SMR_OTEL_LOGS_ENABLED` |
| `apps/smr/Dockerfile` | Add `SMR_OTEL_LOGS_ENABLED` env default |
| `apps/smr/src/smr/tests/unit/test_telemetry.py` | Update imports to new module path |
| `apps/smr/src/smr/tests/unit/test_observability.py` | Update imports if needed |

## 6. Files to Delete

None — `telemetry.py` becomes a compatibility shim, not deleted.

---

## 7. Risk Analysis

| Risk | Mitigation |
|------|-----------|
| **Duplicate OTLP log export** — `LoggingInstrumentor` may auto-install a handler alongside our manual `LoggingHandler` | Use only `LoggingInstrumentor` for handler installation (don't manually add `LoggingHandler` AND call `instrument()`), OR set `OTEL_PYTHON_LOG_AUTO_INSTRUMENTATION=false` |
| **Infinite recursion** — if OTLP endpoint is down, `OTLPLogExporter` logs a warning, which triggers another export attempt | Requires `opentelemetry-sdk>=1.36.0` (we have `>=1.39.0`) which includes `DuplicateFilter` fix |
| **Test pollution** — OTel global state (`LoggerProvider`, root logger handlers) leaks between tests | Add cleanup fixtures that reset `LoggerProvider` and remove `LoggingHandler` from root logger after each test |
| **structlog field flattening** — structlog's bound fields end up in the `msg` string, not as separate OTel attributes | Acceptable for now; a dedicated structlog OTel handler (contrib PR #2139) is WIP upstream |
| **Uvicorn access log disabling** — may hide useful info in local dev | stdout path still works; only OTLP path sees structured access logs from middleware |

---

## 8. Verification Criteria

### Automated (Tests)

- [ ] All new TDD tests pass (red → green → refactor for each)
- [ ] All existing 697+ tests pass
- [ ] No new linter errors on modified files

### Manual (Integration)

- [ ] Start SMR with `SMR_OTEL_ENABLED=true` pointing to a running OTel Collector
- [ ] Verify logs appear in Grafana Loki with `{service_name="smr"}` label
- [ ] Verify `traceId` field in Loki log entries matches traces in Tempo
- [ ] Click a `traceId` in Loki → opens corresponding trace in Tempo
- [ ] Verify uvicorn startup logs appear in Loki (via `uvicorn.error` propagation)
- [ ] Verify no duplicate access log entries (only `RequestLoggingMiddleware` entries, not uvicorn access logs)
- [ ] Verify graceful shutdown: stop SMR → all buffered logs flushed to Loki

---

## 9. Implementation Summary

### What Was Built

Complete OTLP log export pipeline for the SMR service, bridging all Python logs (application, structlog, uvicorn) to the OTel Collector and ultimately to Grafana Loki with full trace correlation.

### Architecture Implemented

```
structlog loggers ──→ structlog pipeline ──→ stdlib logging.Logger
                          │                          │
                          │ (_add_otel_context        │
                          │  injects traceId/spanId)  │
                          │                          │
                          ▼                          ▼
                  JSONRenderer output ──→ StreamHandler ──→ stdout (container logs)
                                                     │
                                         LoggingHandler ──→ BatchLogRecordProcessor
                                                                    │
                                                            OTLPLogExporter
                                                                    │
                                                            OTel Collector :4317
                                                                    │
                                                            otlphttp/loki
                                                                    │
                                                            Grafana Loki
```

### Files Created

| File | Purpose |
|------|---------|
| `apps/smr/src/smr/core/observability.py` | Consolidated OTel setup: TracerProvider + LoggerProvider + auto-instrumentation |
| `apps/smr/src/smr/tests/unit/test_observability.py` | 24 TDD tests covering all new functionality |
| `apps/smr/.env.production` | Production environment variables with OTel log bridge enabled |

### Files Modified

| File | Changes |
|------|---------|
| `apps/smr/pyproject.toml` | Added `opentelemetry-instrumentation-logging>=0.60b1` dependency |
| `apps/smr/src/smr/core/config.py` | Added `otel_logs_enabled: bool = True` to Settings |
| `apps/smr/src/smr/core/logging.py` | Added `_configure_uvicorn_logging()` to disable duplicate access logs and propagate uvicorn.error |
| `apps/smr/src/smr/core/telemetry.py` | Converted to compatibility shim re-exporting from observability.py |
| `apps/smr/src/smr/main.py` | Switched to `setup_opentelemetry`/`shutdown_opentelemetry`, initialised `logger_provider` state |
| `apps/smr/.env.example` | Added `SMR_OTEL_LOGS_ENABLED=true` |
| `apps/smr/Dockerfile` | Added `SMR_OTEL_LOGS_ENABLED=true` env default |
| `apps/smr/src/smr/tests/unit/test_telemetry.py` | Updated mock patch path for `setup_opentelemetry` |

### Key Design Decisions

1. **No file rename** — `telemetry.py` kept as a backward-compatible shim instead of being deleted. All provider files still import `get_tracer` from `telemetry` without any changes.
2. **LoggingInstrumentor with `set_logging_format=False`** — prevents the instrumentor from overwriting the log format; trace context is already injected by structlog's `_add_otel_context` processor.
3. **PHI sanitization hook** — redacts `http.request.body.content` and `http.response.body.content` span attributes to prevent sensitive health data in traces.
4. **Health URL exclusion** — prevents noisy health check spans in Tempo.
5. **Uvicorn access log disabled** — `RequestLoggingMiddleware` already emits structured JSON for every request; uvicorn's unstructured access log is redundant.

### Test Results

- 24 new tests in `test_observability.py`: all passed
- 18 existing tests in `test_telemetry.py`: all passed (via compatibility shim)
- 754 total SMR tests: all passed, 0 failures

---

## 10. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-03 | Initial implementation plan created | This file |
| 2026-04-03 | Implementation completed: observability.py, telemetry shim, config, logging, main.py, tests | See section 9 |
