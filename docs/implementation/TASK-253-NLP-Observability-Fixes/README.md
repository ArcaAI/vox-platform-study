# TASK-253: NLP Service Observability Fixes

| Field | Value |
|-------|-------|
| **Ticket** | TASK-253 |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 |
| **Status** | Completed |
| **Type** | Bugfix / Infrastructure |
| **Priority** | High |
| **Parent** | TASK-251 (Observability Stack) |

---

## 1. Requirement Analysis

### 1.1 Description

Fix critical observability bugs in the NLP service (`apps/nlp/`) that prevent it from working with the TASK-251 Grafana/OTel observability stack. The NLP app has OTel packages installed and basic wiring, but several bugs cause silent data loss, runtime crashes, and broken trace-log correlation.

### 1.2 Business Context

- NLP service processes medical text — observability is required for production readiness
- Without these fixes, NLP traces/metrics never reach the OTel Collector on VM 400
- Log-trace correlation is broken, making distributed debugging impossible
- `OTEL_RESOURCE_ATTRIBUTES` parsing bug will crash the app on startup in production

### 1.3 Acceptance Criteria

- [ ] `OTEL_RESOURCE_ATTRIBUTES` env var parsed correctly from OTel standard format
- [ ] MeterProvider exports metrics via OTLP gRPC to OTel Collector
- [ ] JSON logs contain `traceId` and `spanId` fields for Loki→Tempo correlation
- [ ] `OTLPSpanExporter` uses `insecure=True` for non-TLS collector
- [ ] Health endpoints excluded from OTel tracing
- [ ] Console handler supports JSON format for container deployments
- [ ] Dockerfile includes `OTEL_EXPORTER_OTLP_ENDPOINT`
- [ ] Timestamps use UTC with timezone indicator
- [ ] Config fields consolidated (no duplicate OTLP endpoint fields)
- [ ] Custom NLP business metrics defined (inference latency, entity counts)
- [ ] PHI sanitization hook prevents sensitive data in spans
- [ ] No new linter errors introduced

---

## 2. Current State Evaluation

### 2.1 Audit Score: 6.5/10

| Pillar | Score | Issue |
|---|---|---|
| Prometheus Metrics | 7/10 | Works but only generic HTTP metrics |
| Traces (OTel) | 4/10 | TracerProvider configured but `insecure=True` missing |
| OTel Metrics | 1/10 | MeterProvider has no exporter — all metrics dropped |
| Logging | 3/10 | No traceId/spanId in JSON; console is plaintext |
| Health | 8/10 | Clean 3-tier design |
| Config | 4/10 | `OTEL_RESOURCE_ATTRIBUTES` crashes; duplicate fields |

### 2.2 Files to Modify

| File | Changes |
|------|---------|
| `apps/nlp/src/nlp/core/config.py` | Fix resource_attributes parsing, consolidate fields, fix pydantic usage |
| `apps/nlp/src/nlp/core/observability.py` | Fix MeterProvider, add insecure=True, exclude health URLs, add PHI hook |
| `apps/nlp/src/nlp/core/logging.py` | Add traceId/spanId to JsonFormatter, UTC timestamps, JSON console option |
| `apps/nlp/Dockerfile` | Add OTEL_EXPORTER_OTLP_ENDPOINT, LOG_CONSOLE_JSON_FORMAT |
| `apps/nlp/.env.example` | Add new env vars |

### 2.3 Files to Create

| File | Purpose |
|------|---------|
| `apps/nlp/src/nlp/core/metrics.py` | Custom NLP business metrics (inference, entities, models) |

---

## 3. Implementation Plan

### P0 — Startup Crashers

1. Fix `OTEL_RESOURCE_ATTRIBUTES` type from `dict` to `Optional[str]` with parser
2. Add `OTLPMetricExporter` + `PeriodicExportingMetricReader` to MeterProvider

### P1 — Broken Functionality

3. Add `otelTraceID`/`otelSpanID` extraction to `JsonFormatter`
4. Add `insecure=True` to `OTLPSpanExporter`
5. Add health endpoints to OTel excluded URLs
6. Add `LOG_CONSOLE_JSON_FORMAT` env var for JSON console output

### P2 — Configuration & Enhancement

7. Add `OTEL_EXPORTER_OTLP_ENDPOINT` to Dockerfile
8. Fix timestamps to UTC with timezone
9. Consolidate duplicate config fields, improve pydantic-settings usage
10. Create custom NLP business metrics module

### P3 — Security

11. Add PHI sanitization `server_request_hook`

---

## 4. Implementation Summary

### Files Modified

| File | Changes |
|------|---------|
| `apps/nlp/src/nlp/core/config.py` | Fixed `resource_attributes` type from `dict` to `str` with parser; consolidated duplicate `opentelemetry_endpoint`/`otlp_endpoint` into single `otlp_endpoint`; moved env var resolution to `__init__` to avoid import-time `os.getenv`; added `_parse_otel_resource_attributes()` function; removed unused `field_validator` import |
| `apps/nlp/src/nlp/core/observability.py` | Added `OTLPMetricExporter` + `PeriodicExportingMetricReader` to MeterProvider; added `OTLPLogExporter` + `LoggerProvider` + `BatchLogRecordProcessor` + `LoggingHandler` to bridge all Python logs to OTLP export → OTel Collector → Loki; added `insecure=True` to `OTLPSpanExporter`; added `/api/v1/health*` to excluded URLs; added `_phi_sanitization_hook` for span attribute sanitization; fixed `DEPLOYMENT_ENVIRONMENT` to use `.value` on enum; added `LoggingInstrumentor.uninstrument()` in shutdown; added startup log with endpoint info; references consolidated `otlp_endpoint` field |
| `apps/nlp/src/nlp/core/logging.py` | Added `traceId`/`spanId`/`traceFlags`/`service.name` extraction from OTel `LoggingInstrumentor` to `JsonFormatter`; fixed timestamps to UTC with `timezone.utc`; added `LOG_CONSOLE_JSON_FORMAT` env var for JSON console output in containers; fixed `utc=True` on `TimedRotatingFileHandler` |
| `apps/nlp/Dockerfile` | Added `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317`; added `LOG_CONSOLE_JSON_FORMAT=true` |
| `apps/nlp/.env.example` | Added `LOG_CONSOLE_JSON_FORMAT`, `OTEL_RESOURCE_ATTRIBUTES` env var examples |

### Files Created

| File | Purpose |
|------|---------|
| `apps/nlp/src/nlp/core/metrics.py` | Custom NLP business metrics module with OTel SDK: inference duration/count/errors histograms/counters, entity extraction counter, classification confidence histogram, model load duration, active inference gauge, and `track_inference()` context manager |

### Issue Resolution Matrix

| # | Issue | Severity | Status | Fix |
|---|-------|----------|--------|-----|
| 1 | MeterProvider no exporter | CRITICAL | Fixed | Added `PeriodicExportingMetricReader` + `OTLPMetricExporter` |
| 2 | `OTEL_RESOURCE_ATTRIBUTES` crash | CRITICAL | Fixed | Changed type to `Optional[str]`, added parser function |
| 3 | Trace-log correlation broken | HIGH | Fixed | `JsonFormatter` now emits `traceId`/`spanId`/`traceFlags` |
| 4 | `insecure=True` missing | HIGH | Fixed | Added to `OTLPSpanExporter` constructor |
| 5 | Health endpoints not excluded | HIGH | Fixed | Added 3 health URLs to excluded list |
| 6 | Console uses plaintext | HIGH | Fixed | Added `LOG_CONSOLE_JSON_FORMAT` option |
| 7 | Missing OTLP endpoint in Dockerfile | MEDIUM | Fixed | Added `OTEL_EXPORTER_OTLP_ENDPOINT` |
| 8 | Naive local timestamps | MEDIUM | Fixed | `datetime.fromtimestamp(ts, tz=timezone.utc)` |
| 9 | Duplicate config fields | MEDIUM | Fixed | Consolidated to single `otlp_endpoint` |
| 10 | No business metrics | MEDIUM | Fixed | Created `nlp.core.metrics` module |
| 11 | PHI leak risk | MEDIUM | Fixed | Added `_phi_sanitization_hook` |
| 12 | `DEPLOYMENT_ENVIRONMENT` enum | LOW | Fixed | Uses `.value` for string serialization |
| 13 | LoggingInstrumentor not uninstrumented | LOW | Fixed | Added to `shutdown_opentelemetry()` |
| 14 | File rotation `utc=False` | LOW | Fixed | Changed to `utc=True` |
| 15 | **No OTel log export — logs never reach Loki** | CRITICAL | Fixed | Added `LoggerProvider` + `OTLPLogExporter` + `BatchLogRecordProcessor` + `LoggingHandler` bridge |

---

## 5. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-03 | Initial audit and implementation plan | This file |
| 2026-04-03 | Implementation of all 15 fixes across observability, logging, config, metrics, PHI sanitization, and Dockerfile | `config.py`, `observability.py`, `logging.py`, `metrics.py` (new), `Dockerfile`, `.env.example` |
| 2026-04-03 | TDD: 23 characterization tests added across 6 groups — LoggerProvider setup (4), log export via OTLP (5), JsonFormatter trace correlation (5), config parsing (4), PHI sanitization (3), metrics (2). All 27 tests (4 health + 23 observability) pass. | `apps/nlp/tests/test_observability.py` (new) |

---

## 6. Test Results

### Test File Created

`apps/nlp/tests/test_observability.py` — 23 tests across 6 groups

### Test Groups

| Group | Tests | Behavior Verified |
|-------|-------|-------------------|
| LoggerProvider Setup | 4 | `LoggerProvider` created and stored on `app.state`, `LoggingHandler` attached to root logger, OTel disabled when no endpoint, `shutdown()` flushes provider |
| Log Export via OTLP | 5 | Log records exported through OTel pipeline, trace_id/span_id correlation, service resource attributes, severity mapping, message body preservation |
| JsonFormatter Trace Correlation | 5 | `traceId`/`spanId` in JSON output during active span, omitted without span, UTC timestamps, `service.name` attribute |
| Config Parsing | 4 | `key=val,key=val` parsing, empty/None handling, equals-in-value edge case, `None` when endpoint unset |
| PHI Sanitization | 3 | Request body redacted, response body redacted, no-op on non-recording span |
| Metrics | 2 | `MeterProvider` with `PeriodicExportingMetricReader` created, `track_inference()` context manager records duration + counter |

### Full Test Suite Output

```
27 passed, 21 warnings in 7.58s

tests/test_health.py::test_root_returns_service_info PASSED
tests/test_health.py::test_health_returns_status PASSED
tests/test_health.py::test_liveness_always_healthy PASSED
tests/test_health.py::test_readiness_with_loaded_models PASSED
tests/test_observability.py::TestLoggerProviderSetup::test_setup_creates_logger_provider PASSED
tests/test_observability.py::TestLoggerProviderSetup::test_setup_adds_logging_handler_to_root PASSED
tests/test_observability.py::TestLoggerProviderSetup::test_setup_skipped_without_endpoint PASSED
tests/test_observability.py::TestLoggerProviderSetup::test_shutdown_flushes_logger_provider PASSED
tests/test_observability.py::TestLogExportOTLP::test_log_record_exported_via_otlp PASSED
tests/test_observability.py::TestLogExportOTLP::test_log_record_has_trace_correlation PASSED
tests/test_observability.py::TestLogExportOTLP::test_log_record_has_service_resource PASSED
tests/test_observability.py::TestLogExportOTLP::test_log_record_has_severity PASSED
tests/test_observability.py::TestLogExportOTLP::test_log_record_body_contains_message PASSED
tests/test_observability.py::TestJsonFormatterTraceCorrelation::test_json_formatter_includes_trace_id PASSED
tests/test_observability.py::TestJsonFormatterTraceCorrelation::test_json_formatter_includes_span_id PASSED
tests/test_observability.py::TestJsonFormatterTraceCorrelation::test_json_formatter_omits_trace_when_no_span PASSED
tests/test_observability.py::TestJsonFormatterTraceCorrelation::test_json_formatter_uses_utc_timestamp PASSED
tests/test_observability.py::TestJsonFormatterTraceCorrelation::test_json_formatter_includes_service_name PASSED
tests/test_observability.py::TestConfigParsing::test_resource_attributes_parsed_from_string PASSED
tests/test_observability.py::TestConfigParsing::test_resource_attributes_empty_when_unset PASSED
tests/test_observability.py::TestConfigParsing::test_resource_attributes_handles_equals_in_value PASSED
tests/test_observability.py::TestConfigParsing::test_otlp_endpoint_none_when_unset PASSED
tests/test_observability.py::TestPHISanitization::test_phi_hook_redacts_request_body PASSED
tests/test_observability.py::TestPHISanitization::test_phi_hook_redacts_response_body PASSED
tests/test_observability.py::TestPHISanitization::test_phi_hook_noop_on_non_recording_span PASSED
tests/test_observability.py::TestMetrics::test_setup_creates_meter_provider_with_reader PASSED
tests/test_observability.py::TestMetrics::test_nlp_metrics_inference_tracking PASSED
```

### Linter

Zero new linter errors introduced.
