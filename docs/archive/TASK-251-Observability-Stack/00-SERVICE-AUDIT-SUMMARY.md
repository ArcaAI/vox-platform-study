# Service Observability Audit Summary

| Field | Value |
|-------|-------|
| **Audit Date** | 2026-04-02 |
| **Services Reviewed** | API Gateway, STT, SMR, NLP, @arcaai/vox SDK |
| **Purpose** | Identify gaps before wiring telemetry to the observability stack |

---

## Scorecard

| Service | Logging | Metrics | Tracing (OTel) | Health | Overall |
|---------|---------|---------|----------------|--------|---------|
| **API Gateway** | 8/10 (5 transports, but no auto trace context) | 6/10 (custom metrics exist but not wired to interceptors) | 1/10 (SDK installed but never bootstrapped) | 7/10 (no DB/Redis checks) | 5.5/10 |
| **STT** | 3/10 (structlog used but never configured) | 3/10 (default HTTP metrics only) | 0/10 (7 packages installed, zero code) | 8/10 (DB, MinIO, Redis checks) | 3.5/10 |
| **SMR** | 10/10 (structlog + JSON + request ID + audit) | 10/10 (14 custom metrics) | 9/10 (opt-in, working) | 8/10 (per-provider checks) | 9.5/10 |
| **NLP** | 6/10 (JSON formatter but no trace-log correlation) | 5/10 (default metrics only, no business metrics) | 6/10 (TracerProvider works, MeterProvider broken) | 8/10 (per-model checks) | 6.5/10 |
| **@arcaai/vox** | 9/10 (4 transports, PHI redaction) | 0/10 (no client-side metrics) | 7/10 (traceparent on HTTP, missing on WS) | N/A | 5/10 |

---

## Critical Findings by Service

### API Gateway (`apps/api/`)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | **No OTel SDK bootstrap** — `@opentelemetry/sdk-node` installed but no `instrumentation.ts` | CRITICAL | Create `apps/api/src/instrumentation.ts` with `NodeSDK` |
| 2 | **No automatic trace context in logs** — traceId/spanId only if manually passed | CRITICAL | Import from active OTel span context in LoggingService |
| 3 | **`.env.example` has `OTEL_SERVICE_NAME=hope-tts`** — wrong service name | HIGH | Fix to `api-gateway` |
| 4 | **`.env.production` has `NODE_ENV=development`** | HIGH | Fix to `production` |
| 5 | **No HTTP request metrics interceptor wired** — `recordHttpRequest()` exists but never called | HIGH | Wire in ContextInterceptor or create MetricsInterceptor |
| 6 | **Health checks don't probe Redis or PostgreSQL** | MEDIUM | Add Terminus health indicators |
| 7 | **Dual metrics systems** — prom-client + @opentelemetry/api (latter is no-op) | MEDIUM | Consolidate after OTel SDK bootstrap |
| 8 | **`@sentry/node` still in package.json** but unused | LOW | Remove dead dependency |

### STT (`apps/stt/`)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | **No `structlog.configure()`** — logs are unstructured dev format, not JSON | CRITICAL | Create `core/logging.py` following SMR pattern |
| 2 | **Zero OTel instrumentation code** — 7 packages installed, zero imports | CRITICAL | Create `core/telemetry.py` following SMR pattern |
| 3 | **No request context in logs** — no requestId, traceId, spanId injection | CRITICAL | Create `RequestIDMiddleware` following SMR pattern |
| 4 | **No custom Prometheus metrics** | HIGH | Add transcription histograms, session gauges |
| 5 | **Mixed logging libraries** — 18 files structlog, 14+ files stdlib logging | HIGH | Configure structlog's stdlib integration |
| 6 | **No OTel settings in Settings class** | MEDIUM | Add `otel_enabled`, `otel_exporter_endpoint`, etc. |

### SMR (`apps/smr/`)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | No Redis health check in `/health` endpoint | LOW | Add Redis check in health endpoint |
| 2 | `insecure=True` hardcoded in OTLP exporter | LOW | Acceptable for internal network |
| 3 | Uses custom `SMR_OTEL_*` env vars instead of standard `OTEL_*` | LOW | Acceptable, documented |

**SMR is production-ready — minimal work needed.**

### NLP (`apps/nlp/`)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | **MeterProvider has no exporter** — OTel metrics collected but never exported | CRITICAL | Add `PeriodicExportingMetricReader` with `OTLPMetricExporter` |
| 2 | **`OTEL_RESOURCE_ATTRIBUTES` runtime crash** — parsed as string, used as dict | HIGH | Parse `"key=val,key=val"` format properly |
| 3 | **`/health` not excluded from OTel tracing** — noisy health check traces | HIGH | Add to excluded_urls list |
| 4 | **Trace-log correlation broken** — LoggingInstrumentor active but JsonFormatter ignores trace fields | HIGH | Extract `otelTraceID`/`otelSpanID` from log record |
| 5 | **Missing `OTEL_EXPORTER_OTLP_ENDPOINT` in Dockerfile** — effectively disables OTel | MEDIUM | Add to Dockerfile ENV |
| 6 | **`JsonFormatter` uses local time without timezone** | MEDIUM | Use `timezone.utc` |
| 7 | **No custom NLP business metrics** | MEDIUM | Add inference latency, entity counts |

### @arcaai/vox SDK (`packages/agentic-sdk-v2/`)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | **No Grafana Faro integration** | HIGH | Create `FaroIntegration.ts` module |
| 2 | **No Web Vitals capture** (CLS, LCP, INP, TTFB) | HIGH | Faro auto-captures these |
| 3 | **No client-side metrics** (counters, histograms, gauges) | HIGH | Use Faro `pushMeasurement()` |
| 4 | **No audio pipeline metrics exported** | MEDIUM | Add `pushEvent()` calls |
| 5 | **No WebSocket trace context propagation** | MEDIUM | Send traceparent as first-frame JSON |
| 6 | **PHI redaction only checks top-level keys** | LOW | Future enhancement |

---

## Implementation Priority

Based on the audit, the implementation order for Phase 2 should be:

1. **SMR** — Already 9.5/10. Just enable OTel with env vars. (30 min)
2. **NLP** — Has OTel infrastructure but needs bug fixes. (2-3 hours) → **TASK-253**
3. **API Gateway** — Needs `instrumentation.ts` and env var fixes. (4 hours) → **TASK-252**
4. **STT** — Needs logging, telemetry, and middleware modules from scratch. (1 day)
5. **@arcaai/vox** — Needs Faro integration. (1-2 days, Phase 4)

---

## Files to Create

| Service | File | Purpose |
|---------|------|---------|
| API Gateway | `apps/api/src/instrumentation.ts` | OTel SDK bootstrap |
| STT | `apps/stt/src/stt/core/logging.py` | structlog configuration |
| STT | `apps/stt/src/stt/core/telemetry.py` | OTel tracing setup |
| STT | `apps/stt/src/stt/core/middleware/request_id.py` | Request ID middleware |
| @arcaai/vox | `packages/agentic-sdk-v2/src/core/faro/FaroIntegration.ts` | Grafana Faro integration |

## Files to Modify

| Service | File | Changes |
|---------|------|---------|
| API Gateway | `apps/api/src/main.ts` | Add `import './instrumentation'` as first line |
| API Gateway | `apps/api/.env.example` | Fix `OTEL_SERVICE_NAME=api-gateway` |
| API Gateway | `apps/api/.env.production` | Fix `NODE_ENV=production` |
| NLP | `apps/nlp/src/nlp/core/observability.py` | Fix MeterProvider, excluded_urls, resource attributes |
| NLP | `apps/nlp/src/nlp/core/logging.py` | Fix JsonFormatter trace-log correlation + UTC time |
| NLP | `apps/nlp/Dockerfile` | Add `OTEL_EXPORTER_OTLP_ENDPOINT` |
| STT | `apps/stt/src/stt/main.py` | Wire logging, telemetry, middleware |
| STT | `apps/stt/src/stt/core/config/settings.py` | Add OTel settings fields |
| @arcaai/vox | `packages/agentic-sdk-v2/src/types/config.ts` | Add `faro` to `LoggingConfig` |
| @arcaai/vox | `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | Initialize Faro on mount |
