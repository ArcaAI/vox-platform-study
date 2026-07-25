# Phase 2 & 4: Telemetry Configuration Plan

| Field | Value |
|-------|-------|
| **Phase** | 2 (Server-Side) + 4 (Client-Side RUM) |
| **Effort** | ~2 days (Phase 2) + ~2 days (Phase 4) |
| **Prerequisites** | Phase 1 complete — all 5 containers healthy on VM 400 |

---

## Table of Contents

1. [Pre-Flight: VM 200 Port Verification](#1-pre-flight-vm-200-port-verification)
2. [API Gateway Telemetry](#2-api-gateway-telemetry)
3. [STT Telemetry](#3-stt-telemetry)
4. [SMR Telemetry](#4-smr-telemetry)
5. [NLP Telemetry](#5-nlp-telemetry)
6. [Client-Side RUM: @arcaai/vox + Grafana Faro](#6-client-side-rum-arcaaivox--grafana-faro)
7. [Verification Matrix](#7-verification-matrix)

---

## 1. Pre-Flight: VM 200 Port Verification

**Purpose**: Confirm that Prometheus on VM 400 can reach `/metrics` endpoints on VM 200, and that services can push OTLP to VM 400.

### Step 1.1 — Test Connectivity from VM 400

```bash
ssh hope@10.10.1.100

# Test each service's /metrics endpoint
curl -s http://10.10.1.10:8868/metrics | head -5   # API Gateway
curl -s http://10.10.1.10:8861/metrics | head -5   # STT
curl -s http://10.10.1.10:8862/metrics | head -5   # SMR
curl -s http://10.10.1.10:8864/metrics | head -5   # NLP
```

**If any returns "connection refused"**, the service is either:
- Not running
- Bound to `127.0.0.1` instead of `0.0.0.0`
- Behind a K3s ClusterIP that doesn't expose the port externally

### Step 1.2 — Fix K3s Port Exposure (if needed)

```bash
ssh hope@10.10.1.10

# Check current service definitions
kubectl get svc -A | grep -E '8861|8862|8864|8868'

# Option A: Change service type to NodePort
kubectl edit svc <service-name> -n <namespace>
# Change: type: ClusterIP → type: NodePort

# Option B: Add hostNetwork: true to pod spec
kubectl edit deployment <deployment-name> -n <namespace>
# Add under spec.template.spec:
#   hostNetwork: true

# Option C: Use hostPort in container spec
# Add to container ports:
#   - containerPort: 8868
#     hostPort: 8868
```

### Step 1.3 — Test OTLP Push from VM 200 to VM 400

```bash
ssh hope@10.10.1.10

# Test OTLP gRPC port
curl -s http://10.10.1.100:4317
# Expected: connection established (will fail with HTTP error — that's fine, gRPC works)

# Test OTLP HTTP port
curl -s -X POST http://10.10.1.100:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}'
# Expected: 200 OK or similar success response
```

**Gate**: All 4 `/metrics` endpoints accessible from VM 400. OTLP ports 4317/4318 reachable from VM 200.

---

## 2. API Gateway Telemetry

**Service**: `apps/api/` (NestJS, port 8868)
**Current state**: Has LoggingService with 5 transports and `/metrics` endpoint, but NO OTel SDK bootstrap.

### Audit Findings (Critical Gaps)

| # | Gap | Severity |
|---|-----|----------|
| 1 | No `instrumentation.ts` — OTel SDK never bootstrapped | CRITICAL |
| 2 | No automatic trace context in logs (traceId/spanId) | CRITICAL |
| 3 | `.env.example` has wrong `OTEL_SERVICE_NAME=hope-tts` | HIGH |
| 4 | `.env.production` has `NODE_ENV=development` | HIGH |
| 5 | No HTTP request metrics interceptor wired | HIGH |
| 6 | `active_connections_count` always returns 0 | MEDIUM |
| 7 | `@sentry/node` still in package.json but unused | LOW |

### Step 2.1 — Create OTel SDK Bootstrap

Create file: `apps/api/src/instrumentation.ts`

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'api-gateway',
  [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
  'service.namespace': 'hope',
  'deployment.environment': process.env.NODE_ENV || 'production',
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 15000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
    new PrismaInstrumentation(),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown());
```

### Step 2.2 — Import Instrumentation in main.ts

Add as the **very first import** in `apps/api/src/main.ts`:

```typescript
import './instrumentation';
// ... rest of existing imports
```

### Step 2.3 — Install Missing OTel Packages

```bash
cd apps/api
pnpm add @opentelemetry/exporter-trace-otlp-grpc \
         @opentelemetry/exporter-metrics-otlp-grpc \
         @opentelemetry/exporter-logs-otlp-grpc \
         @opentelemetry/sdk-logs \
         @prisma/instrumentation
```

> Note: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, and
> `@opentelemetry/sdk-metrics` are already installed in `packages/applications`.

### Step 2.4 — Fix Environment Variables

Update `apps/api/.env.example`:
```bash
# Fix: was incorrectly set to hope-tts
OTEL_SERVICE_NAME=api-gateway
```

Update `apps/api/.env.production`:
```bash
# Fix: was incorrectly set to development
NODE_ENV=production
```

### Step 2.5 — Set OTel Environment Variables for Deployment

Add to the API Gateway container/pod environment:

```bash
OTEL_SERVICE_NAME=api-gateway
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
OTEL_LOGS_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_RESOURCE_ATTRIBUTES=service.namespace=hope,deployment.environment=production

LOKI_HOST=http://10.10.1.100:3100
LOKI_ENABLED=true
```

### Step 2.6 — Verification

```bash
# From VM 400:

# 1. Check Prometheus target
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json,sys; d=json.load(sys.stdin)
for t in d['data']['activeTargets']:
  if t['labels'].get('job')=='api-gateway':
    print(f\"  Status: {t['health']}, Last scrape: {t.get('lastScrape','')}\")
"
# Expected: Status: up

# 2. Check Loki for API logs
curl -s 'http://localhost:3100/loki/api/v1/query?query={service_name="api-gateway"}&limit=3'
# Expected: log entries from API gateway

# 3. Check Tempo for API traces
curl -s 'http://localhost:3200/api/search?tags=service.name%3Dapi-gateway&limit=3'
# Expected: trace summaries
```

---

## 3. STT Telemetry

**Service**: `apps/stt/` (Python FastAPI, port 8861)
**Current state**: structlog used but NOT configured. OTel packages installed but ZERO instrumentation code.

### Audit Findings (Critical Gaps)

| # | Gap | Severity |
|---|-----|----------|
| 1 | No `structlog.configure()` — logs are unstructured dev format | CRITICAL |
| 2 | No OTel instrumentation code at all — 7 packages are dead weight | CRITICAL |
| 3 | No request context in logs (requestId, traceId, spanId) | CRITICAL |
| 4 | No custom Prometheus metrics (only default HTTP metrics) | HIGH |
| 5 | Mixed logging: 18 files use structlog, 14+ use stdlib logging | HIGH |
| 6 | No OTel settings in Settings class | MEDIUM |

### Step 3.1 — Create Logging Configuration Module

Create file: `apps/stt/src/stt/core/logging.py`

Follow the SMR pattern exactly:

```python
"""Structured logging configuration using structlog."""

from __future__ import annotations

import logging
import sys

import structlog


def setup_logging(log_level: str = "info") -> None:
    """Configure structlog with JSON output for production."""

    level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a bound logger instance."""
    return structlog.get_logger(name)
```

### Step 3.2 — Create Telemetry Module

Create file: `apps/stt/src/stt/core/telemetry.py`

Follow the SMR pattern:

```python
"""OpenTelemetry setup for STT."""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_TRACER_VERSION = "2.0.0"


def setup_telemetry(
    app,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "stt",
) -> None:
    """Configure OpenTelemetry tracing with OTLP gRPC exporter."""
    resource = Resource.create({
        "service.name": service_name,
        "service.version": _TRACER_VERSION,
        "service.namespace": "hope",
        "deployment.environment": "production",
    })

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()


def get_tracer(name: str = "stt") -> trace.Tracer:
    """Get a tracer instance for creating spans."""
    return trace.get_tracer(name, _TRACER_VERSION)
```

### Step 3.3 — Create Request ID Middleware

Create file: `apps/stt/src/stt/core/middleware/request_id.py`

Follow the SMR pattern:

```python
"""Request ID middleware for trace correlation."""

from __future__ import annotations

import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Propagate or generate a request ID and bind it to structured logging."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())

        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()

        response.headers["X-Request-ID"] = request_id
        return response
```

### Step 3.4 — Add OTel Settings to Config

Update `apps/stt/src/stt/core/config/settings.py`:

```python
# Add these fields to the Settings class:
otel_enabled: bool = False
otel_exporter_endpoint: str = "http://localhost:4317"
otel_service_name: str = "stt"
```

### Step 3.5 — Wire Everything in main.py

In `apps/stt/src/stt/main.py`, within the `create_app()` or `lifespan()` function:

```python
from stt.core.logging import setup_logging
from stt.core.middleware.request_id import RequestIDMiddleware

# At app startup:
setup_logging(settings.log_level.lower())

# After app creation:
app.add_middleware(RequestIDMiddleware)

# Conditional OTel:
if settings.otel_enabled:
    from stt.core.telemetry import setup_telemetry
    setup_telemetry(
        app,
        endpoint=settings.otel_exporter_endpoint,
        service_name=settings.otel_service_name,
    )
```

### Step 3.6 — Set Environment Variables for Deployment

```bash
OTEL_SERVICE_NAME=stt
STT_OTEL_ENABLED=true
STT_OTEL_EXPORTER_ENDPOINT=http://10.10.1.100:4317
STT_OTEL_SERVICE_NAME=stt
```

### Step 3.7 — Verification

Same as API Gateway — check Prometheus target UP, Loki has logs, Tempo has traces.

---

## 4. SMR Telemetry

**Service**: `apps/smr/` (Python FastAPI, port 8862)
**Current state**: PRODUCTION READY (9.5/10). structlog, 14 custom Prometheus metrics, OTel opt-in.

### Audit Findings

SMR is the most mature service. Only minor gaps:

| # | Gap | Severity |
|---|-----|----------|
| 1 | Uses custom `SMR_OTEL_*` env vars instead of standard `OTEL_*` | LOW |
| 2 | `insecure=True` hardcoded in OTLP exporter | LOW |
| 3 | No Redis health check in `/health` | LOW |

### Step 4.1 — Enable OTel

Set environment variables for the SMR container/pod:

```bash
SMR_OTEL_ENABLED=true
SMR_OTEL_EXPORTER_ENDPOINT=http://10.10.1.100:4317
SMR_OTEL_SERVICE_NAME=smr
```

### Step 4.2 — Verification

```bash
# From VM 400:

# Prometheus target
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json,sys; d=json.load(sys.stdin)
for t in d['data']['activeTargets']:
  if t['labels'].get('job')=='smr':
    print(f\"  Status: {t['health']}\")
"
# Expected: up

# Verify custom metrics are being scraped
curl -s http://10.10.1.10:8862/metrics | grep smr_generation_total
# Expected: smr_generation_total{...} <value>
```

---

## 5. NLP Telemetry

**Service**: `apps/nlp/` (Python FastAPI, port 8864)
**Current state**: Has OTel setup in `nlp.core.observability` but several bugs.

### Audit Findings

| # | Gap | Severity |
|---|-----|----------|
| 1 | MeterProvider has no exporter — OTel metrics collected but never exported | CRITICAL |
| 2 | `OTEL_RESOURCE_ATTRIBUTES` parsed as string but used as dict — runtime crash | HIGH |
| 3 | `/health` not excluded from OTel tracing (noisy health check traces) | HIGH |
| 4 | Trace-log correlation broken: LoggingInstrumentor active but JsonFormatter doesn't emit trace/span IDs | HIGH |
| 5 | Missing `OTEL_EXPORTER_OTLP_ENDPOINT` in Dockerfile — effectively disables OTel | MEDIUM |
| 6 | `JsonFormatter` uses local time without timezone | MEDIUM |
| 7 | No custom NLP business metrics | MEDIUM |

### Step 5.1 — Fix OTel Setup in observability.py

In `apps/nlp/src/nlp/core/observability.py`:

1. **Add metrics exporter** to MeterProvider:
```python
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint=settings.service.opentelemetry_endpoint, insecure=True),
    export_interval_millis=15000,
)
meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
```

2. **Add `/health` to OTel excluded URLs**:
```python
excluded_urls = "/docs,/redoc,/openapi.json,/metrics,/health,/api/v1/health/live,/api/v1/health/ready"
```

3. **Fix `OTEL_RESOURCE_ATTRIBUTES` parsing**:
```python
# Parse the standard format: "key1=val1,key2=val2"
raw = os.getenv("OTEL_RESOURCE_ATTRIBUTES")
extra_attrs = {}
if raw:
    for pair in raw.split(","):
        k, _, v = pair.partition("=")
        extra_attrs[k.strip()] = v.strip()
```

### Step 5.2 — Fix JsonFormatter Trace-Log Correlation

In `apps/nlp/src/nlp/core/logging.py`, update `JsonFormatter.format()`:

```python
def format(self, record):
    log_data = {
        "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
        # ... existing fields ...
    }

    # Extract OTel trace context injected by LoggingInstrumentor
    for attr in ("otelTraceID", "otelSpanID", "otelServiceName"):
        val = getattr(record, attr, None)
        if val and val != "0":
            log_data[attr] = val

    # ... rest of method ...
```

### Step 5.3 — Set Environment Variables for Deployment

```bash
OTEL_SERVICE_NAME=nlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
OTEL_RESOURCE_ATTRIBUTES=service.name=nlp,service.namespace=hope,deployment.environment=production
```

### Step 5.4 — Verification

Same pattern as other services.

---

## 6. Client-Side RUM: @arcaai/vox + Grafana Faro

**Package**: `packages/agentic-sdk-v2/`
**Current state**: Has 4 transports (Console, Highlight, Loki, OTel) but NO Faro, NO Web Vitals, NO audio metrics.

### Audit Findings

| # | Gap | Severity |
|---|-----|----------|
| 1 | No Grafana Faro integration | HIGH |
| 2 | No Web Vitals capture (CLS, LCP, INP, TTFB) | HIGH |
| 3 | No client-side metrics infrastructure (counters, histograms) | HIGH |
| 4 | No audio pipeline metrics | MEDIUM |
| 5 | No WebSocket trace context propagation | MEDIUM |
| 6 | PHI redaction only checks top-level keys | LOW |

### Step 6.1 — Add Faro Dependencies

```bash
pnpm add -D @grafana/faro-web-sdk @grafana/faro-web-tracing --filter @arcaai/vox
pnpm add -D @grafana/faro-web-sdk @grafana/faro-web-tracing --filter ui-playground
```

### Step 6.2 — Create Faro Integration Module

Create file: `packages/agentic-sdk-v2/src/core/faro/FaroIntegration.ts`

```typescript
import {
  initializeFaro,
  getWebInstrumentations,
  type Faro,
  type FaroConfig,
  LogLevel,
} from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

export interface FaroOptions {
  collectorUrl: string;
  appName?: string;
  appVersion?: string;
  tenantId?: string;
  userId?: string;
  enableTracing?: boolean;
  tracePropagationTargets?: (string | RegExp)[];
}

let faroInstance: Faro | null = null;

export function initFaro(options: FaroOptions): Faro {
  if (faroInstance) return faroInstance;

  const config: FaroConfig = {
    url: options.collectorUrl,
    app: {
      name: options.appName || 'arcaai-vox',
      version: options.appVersion || '2.0.0',
    },
    instrumentations: [
      ...getWebInstrumentations({
        captureConsole: true,
        captureConsoleDisabledLevels: [LogLevel.DEBUG, LogLevel.TRACE],
      }),
      ...(options.enableTracing
        ? [
            new TracingInstrumentation({
              instrumentationOptions: {
                propagateTraceHeaderCorsUrls:
                  options.tracePropagationTargets || [/.*/],
              },
            }),
          ]
        : []),
    ],
    sessionTracking: {
      enabled: true,
      persistent: true,
    },
    batching: {
      enabled: true,
      sendTimeout: 250,
      itemLimit: 50,
    },
  };

  faroInstance = initializeFaro(config);

  if (options.tenantId) {
    faroInstance.api.setUser({
      id: options.userId,
      attributes: { tenantId: options.tenantId },
    });
  }

  return faroInstance;
}

export function getFaro(): Faro | null {
  return faroInstance;
}

export function pushEvent(name: string, attributes?: Record<string, string>): void {
  faroInstance?.api.pushEvent(name, attributes);
}

export function pushError(error: Error, context?: Record<string, string>): void {
  faroInstance?.api.pushError(error, { context });
}

export function setUser(userId: string, tenantId: string): void {
  faroInstance?.api.setUser({
    id: userId,
    attributes: { tenantId },
  });
}

export function destroyFaro(): void {
  faroInstance?.pause();
  faroInstance = null;
}
```

### Step 6.3 — Add Faro Config Type

In `packages/agentic-sdk-v2/src/types/config.ts`, add to `LoggingConfig`:

```typescript
export interface LoggingConfig {
  // ... existing fields ...
  faro?: {
    enabled: boolean;
    collectorUrl: string;
  };
}
```

### Step 6.4 — Integrate Faro in AgenticProvider

In `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`:

```typescript
import { initFaro, setUser, destroyFaro } from '../core/faro/FaroIntegration';

// Inside useEffect initialization:
if (config.logging?.faro?.enabled) {
  initFaro({
    collectorUrl: config.logging.faro.collectorUrl,
    appName: 'arcaai-vox',
    tenantId: config.api.tenantId,
    userId: authUser?.id,
    enableTracing: true,
    tracePropagationTargets: [
      new RegExp(config.api.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    ],
  });
}

// On auth change:
if (authUser) {
  setUser(authUser.id, config.api.tenantId);
}

// On unmount cleanup:
destroyFaro();
```

### Step 6.5 — Instrument Audio Pipeline Events

Add `pushEvent()` calls to key SDK operations:

| Location | Event Name | Attributes |
|----------|-----------|------------|
| Audio capture start | `audio.capture.start` | sessionId, sttMode, noiseFilter |
| Audio capture stop | `audio.capture.stop` | sessionId, durationMs |
| Transcript received | `stt.transcript.received` | latencyMs, wordCount, language |
| WebSocket connect | `ws.connect` | url, reconnectAttempt |
| WebSocket disconnect | `ws.disconnect` | reason, durationMs |
| Summary generation start | `summary.generation.start` | consultationId, provider |
| Summary generation complete | `summary.generation.complete` | consultationId, latencyMs, tokenCount |
| VAD speech detected | `vad.speech_detected` | segmentDurationMs |
| Consultation start | `consultation.start` | consultationId, tenantId |
| Consultation end | `consultation.end` | consultationId, durationMs |

### Step 6.6 — Add Faro to ui-playground

In `apps/ui-playground/src/main.tsx`:

```typescript
import { initializeFaro, getWebInstrumentations } from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

if (import.meta.env.PROD) {
  initializeFaro({
    url: import.meta.env.VITE_FARO_COLLECTOR_URL || 'https://grafana.taphuynh.dev/collect',
    app: {
      name: 'ui-playground',
      version: '1.0.0',
    },
    instrumentations: [
      ...getWebInstrumentations({ captureConsole: true }),
      new TracingInstrumentation(),
    ],
  });
}
```

Add to `apps/ui-playground/.env`:
```bash
VITE_FARO_COLLECTOR_URL=https://grafana.taphuynh.dev/collect
```

### Step 6.7 — Disable Duplicate Transports

When Faro is active, disable the SDK's existing Loki and OTel transports to prevent duplicate telemetry:

```typescript
const config: AgenticConfig = {
  logging: {
    faro: {
      enabled: true,
      collectorUrl: 'https://grafana.taphuynh.dev/collect',
    },
    loki: { enabled: false },
    otel: { enabled: false },
  },
};
```

---

## 7. Verification Matrix

### Phase 2 Gate — Server-Side

| Check | Command (from VM 400) | Expected |
|-------|----------------------|----------|
| Prometheus: api-gateway UP | `curl localhost:9090/api/v1/targets \| grep api-gateway` | health: up |
| Prometheus: stt UP | `curl localhost:9090/api/v1/targets \| grep stt` | health: up |
| Prometheus: smr UP | `curl localhost:9090/api/v1/targets \| grep smr` | health: up |
| Prometheus: nlp UP | `curl localhost:9090/api/v1/targets \| grep nlp` | health: up |
| Prometheus: postgres-exporter UP | `curl localhost:9090/api/v1/targets \| grep postgres` | 3 targets up |
| Prometheus: patroni UP | `curl localhost:9090/api/v1/targets \| grep patroni` | 3 targets up |
| Prometheus: etcd UP | `curl localhost:9090/api/v1/targets \| grep etcd` | 3 targets up |
| Prometheus: redis UP | `curl localhost:9090/api/v1/targets \| grep redis` | 2 targets up |
| Loki: API logs | `curl 'localhost:3100/loki/api/v1/query?query={service_name="api-gateway"}&limit=3'` | Log entries |
| Loki: STT logs | `curl 'localhost:3100/loki/api/v1/query?query={service_name="stt"}&limit=3'` | Log entries |
| Loki: SMR logs | `curl 'localhost:3100/loki/api/v1/query?query={service_name="smr"}&limit=3'` | Log entries |
| Loki: NLP logs | `curl 'localhost:3100/loki/api/v1/query?query={service_name="nlp"}&limit=3'` | Log entries |
| Tempo: Traces | `curl 'localhost:3200/api/search?limit=5'` | Traces with multiple services |
| Cross-service trace | Trigger `/api/v1/health/services` → check Tempo | One trace spanning API + downstream |

### Phase 4 Gate — Client-Side RUM

| Check | Method | Expected |
|-------|--------|----------|
| Faro SDK initializes | Open ui-playground, check browser console | No errors, Faro session created |
| Web Vitals captured | Grafana → Explore → Loki: `{app="arcaai-vox"}` | LCP, CLS, INP events |
| JS errors captured | Throw test error in console | Error with stack trace in Grafana |
| Custom events | Perform consultation | `audio.capture.start`, `stt.transcript.received` events |
| Browser traces in Tempo | Grafana → Tempo → search service.name=arcaai-vox | Browser-originated traces |
| Trace correlation | Click browser trace → verify backend spans | Linked API Gateway + STT spans |
| Session metadata | Check Faro session data | tenantId, userId present |
