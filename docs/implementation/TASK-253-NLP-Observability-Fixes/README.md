# TASK-253: NLP Service Observability Fixes

| Field | Value |
|-------|-------|
| **Ticket** | TASK-253 |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 |
| **Status** | In Progress |
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
| `apps/nlp/src/nlp/core/observability.py` | Added `OTLPMetricExporter` + `PeriodicExportingMetricReader` to MeterProvider; added `insecure=True` to `OTLPSpanExporter`; added `/api/v1/health*` to excluded URLs; added `_phi_sanitization_hook` for span attribute sanitization; fixed `DEPLOYMENT_ENVIRONMENT` to use `.value` on enum; added `LoggingInstrumentor.uninstrument()` in shutdown; added startup log with endpoint info; references consolidated `otlp_endpoint` field |
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

---

## 5. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-03 | Initial audit and implementation plan | This file |
