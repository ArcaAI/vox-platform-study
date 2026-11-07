# Observability, Log Signatures & Request Tracing

This document provides a guide for diagnosing issues across the distributed HOPE ecosystem by following request correlation IDs, parsing structured log signatures, and inspecting Prometheus telemetry.

---

## 1. Request Correlation ID Lifecycle

Every interaction with the HOPE platform carries a unique `correlationId`. This ID allows a developer to trace a single client request as it traverses multiple services:

```text
[Client Request] 
      │ (Optional: X-Correlation-Id: corr-12345)
      ▼
[API Gateway: ContextInterceptor / ClsGuard]
      ├── Reads or generates correlationId: "corr-12345"
      ├── Binds correlationId to AsyncLocalStorage via ClsService
      ├── Attaches response header: X-Correlation-Id: corr-12345
      │
      ├── [Downstream HTTP to Python Services] (STT 8861, Text 8862, NLP 8864)
      │     └── Forwards headers:
      │           • X-Correlation-Id: corr-12345
      │           • X-Request-Id: req-67890
      │           • X-Tenant-Id: <tenant-uuid>
      │
      ├── [Temporal Workflows] (Harness Clinical Loop)
      │     └── Sets Search Attribute: CorrelationId = "corr-12345"
      │
      └── [PostgreSQL & Prisma]
            └── Tagged in SQL query comment for pg_stat_activity tracing
```

### How to Trace a Request from an Error:
When a client reports an error, ask for the `correlationId` from the error envelope:
```json
{
  "statusCode": 500,
  "code": "HTTP.INTERNAL_SERVER_ERROR",
  "correlationId": "corr-b17d05e2-45a8-48b2-8419-79883bfd3c41"
}
```
Then search across all platform logs simultaneously:
```bash
# Grep across gateway and microservice log files
rg "corr-b17d05e2-45a8-48b2-8419-79883bfd3c41" /var/log/hope/
```

---

## 2. Production Log Signatures & Grep Patterns

Here are the exact log signatures emitted by `apps/api` for critical failure states:

### 1. Authentication & Permission Rejection
```text
# Log Line Pattern
WARN  [UnifiedAuthGuard] Access denied: path=/api/v1/admin/users method=POST reason=API_KEY_FORBIDDEN principal=apiKey:key-test-123 correlationId=corr-xxx
WARN  [UnifiedAuthGuard] CASL permission check failed: user=usr-456 action=manage subject=Department correlationId=corr-xxx
```
- **Grep Query:** `grep "UnifiedAuthGuard.*Access denied" api.log`
- **Meaning:** User lacks CASL role or API key hit an admin route.

### 2. Cross-Tenant Attempt (404-over-403)
```text
# Log Line Pattern
WARN  [TenantContext] Cross-tenant access attempted: callerTenant=11111111-1111-1111-1111-111111111111 requestedEntityTenant=22222222-2222-2222-2222-222222222222 entity=Consultation id=c-999
```
- **Grep Query:** `grep "Cross-tenant access attempted" api.log`
- **Meaning:** User received a 404 because the resource belongs to another hospital tenant.

### 3. Patient Consent Denials
```text
# Log Line Pattern
WARN  [PatientConsentGuard] Unconditional consent denied: patientId=pat-1002 tenantId=tenant-1 action=read:Consultation correlationId=corr-xxx
```
- **Grep Query:** `grep "PatientConsentGuard.*consent denied" api.log`
- **Meaning:** Patient has not granted active consent or consent was revoked.

### 4. Rate Limiting Throttling (429)
```text
# Log Line Pattern
WARN  [TieredThrottlerGuard] Rate limit exceeded: tier=strict ip=192.168.1.50 key=auth.login hits=11 limit=10 ttl=60s correlationId=corr-xxx
```
- **Grep Query:** `grep "TieredThrottlerGuard.*Rate limit exceeded" api.log`
- **Meaning:** IP or user throttled by Redis sliding-window limiter.

### 5. Optimistic Concurrency Conflict (412)
```text
# Log Line Pattern
INFO  [OptimisticConcurrency] Conflict detected on update: entity=Consultation id=c-123 expectedVersion=5 actualVersion=6 correlationId=corr-xxx
```
- **Grep Query:** `grep "OptimisticConcurrency.*Conflict detected" api.log`
- **Meaning:** Two users updated the same record simultaneously.

### 6. Downstream Microservice Timeouts (504 / 502)
```text
# Log Line Pattern
ERROR [TextProxyController] Downstream service error: target=http://localhost:8862/generate status=504 message="Gateway Timeout" correlationId=corr-xxx
```
- **Grep Query:** `grep "Downstream service error" api.log`
- **Meaning:** Python LLM or STT service failed to respond within timeout window.

---

## 3. Prometheus Telemetry & Critical Metrics

The gateway exposes Prometheus metrics at `GET /metrics` (public endpoint, excluded from the `/api/v1` prefix).

### Essential Metrics for Troubleshooting:

| Metric Name | Type | Normal Threshold | Troubleshooting Indicator |
|---|---|---|---|
| `http_request_duration_seconds_bucket` | Histogram | p95 < 250ms | If p95 > 2s, check downstream Python services and database connection pool. |
| `nestjs_throttler_blocked_total` | Counter | 0 (or low) | Spikes indicate a DDoS attack, misconfigured client loop, or brute-force login attempt. |
| `prisma_client_queries_duration_seconds`| Histogram | p95 < 20ms | Spikes indicate database lock contention or missing Postgres index. |
| `prisma_pool_wait_duration_seconds` | Histogram | 0s | If > 0s, threads are waiting for free database connections (pool exhaustion). |
| `websocket_active_connections` | Gauge | Varies | Sudden drop to 0 indicates network partition or Redis ticket store crash. |
| `nodejs_eventloop_lag_seconds` | Gauge | < 0.05s | If > 0.5s, CPU-bound tasks are blocking the Node.js single thread (e.g. huge JSON parse). |

---

## 4. OpenTelemetry (OTel) Distributed Tracing

HOPE configures OpenTelemetry in [`src/instrumentation.ts`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/instrumentation.ts).

### HIPAA / PHI Safety Invariant:
```text
OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=false
```
The gateway startup audit `assertGenaiContentCaptureDisabled` **will refuse to boot in production** if GenAI content capture is enabled. Patient consultation audio, transcripts, and SOAP drafts are never exported into tracing payloads to ensure strict HIPAA compliance.
