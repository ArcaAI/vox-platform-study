# Research Report: AI Streaming Timeout Audit (HTTP, SSE, WebSocket)

**Date**: 2026-03-09  
**Topic**: Timeout reliability for AI capabilities over HTTP, SSE, and WebSocket  
**Scope**: `apps/api`, `apps/smr`, `apps/stt-v2`, `apps/nlp`, deployment guidance, and stream client behavior

---

## Executive Summary

This audit reviews timeout behavior across gateway, services, and deployment guidance for long-lived AI streaming endpoints.

Main findings:

1. **Critical mismatch**: API stream-init timeout (`30s`) is shorter than SMR queue wait (`60s`), so valid stream requests can fail before task creation under load.
2. **Critical cutoff risk**: API SSE upstream timeout is fixed at `300s`, which can terminate long-running streams before provider completion.
3. **High baseline risk**: shared proxy defaults are `60s` unless overridden; unsafe for long-lived streaming traffic.
4. **Deployment drift risk**: deployment guide shows generic `proxy_read_timeout 60s` for main location; if reused for SSE paths, streams can be dropped.
5. **Session policy mismatch**: STT session inactivity (`60s`) and audio-idle (`300s`) windows can create unexpected client disconnect behavior.

---

## Method and Files Reviewed

### API Gateway (NestJS)

- `apps/api/src/modules/streaming/smr-proxy.controller.ts`
- `apps/api/src/shared/base-proxy.controller.ts`
- `apps/api/src/modules/streaming/streaming.module.ts`
- `apps/api/src/modules/health/health.controller.ts`
- `apps/api/docs/04-deployment-guide.md`

### Python services

- `apps/smr/src/smr_v2/api/endpoints/generate.py`
- `apps/smr/src/smr_v2/api/endpoints/stream.py`
- `apps/smr/src/smr_v2/services/task_manager.py`
- `apps/smr/src/smr_v2/core/config.py`
- `apps/stt-v2/src/stt_v2/core/config/settings.py`
- `apps/stt-v2/src/stt_v2/streaming/session_manager.py`
- `apps/stt-v2/src/stt_v2/streaming/redis_streams.py`
- `apps/nlp/src/nlp/core/config.py`
- `apps/nlp/src/nlp/core/websocket_manager.py`

### Infrastructure and client behavior

- `infrastructure/docker/docker-compose.yml`
- `infrastructure/docker/docker-compose.dev.yml`
- `apps/ui-playground/src/features/summarization/api/smr-client.ts`
- `packages/agentic-sdk-v2/src/core/SSEClient.ts`
- `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`

---

## Timeout Inventory (Key Values)

### API Gateway

- Base proxy default timeout: `60_000ms` (`proxyTimeout`, `timeout`)
- SMR generate timeout:
  - stream request path: `30_000ms`
  - non-stream request path: `120_000ms`
- SMR SSE upstream timeout: `300_000ms`
- SSE keepalive heartbeat interval: `15_000ms`
- Streaming module `HttpModule` timeout: `120_000ms`
- Health probe downstream timeout: `5_000ms`

### SMR service

- Provider timeouts:
  - `ollama.timeout_s = 300`
  - `azure.timeout_s = 120`
  - `bedrock.timeout_s = 120`
  - `openai_compat.timeout_s = 300`
- Queue max wait: `60s`
- Semaphore acquire timeout: `30s`
- Redis stream blocking read: `5000ms`

### STT-v2 service

- API gateway client timeout: `30s`
- Worker timeout: `600000ms`
- Transcription timeout: `300s`
- Streaming session timeout (inactivity): `60s`
- Streaming audio idle timeout: `300s`
- Redis stream blocking read: `5000ms`

### NLP service

- Config defaults: `connection_timeout=300`, `heartbeat_interval=30`, `ping_timeout=10`
- Runtime manager constants differ: `WAIT_TIMEOUT=60`, `HEARTBEAT_INTERVAL=30`, `HEARTBEAT_TIMEOUT=90`

### Deployment guidance

- Main location template in Nginx sample uses:
  - `proxy_connect_timeout 60s`
  - `proxy_send_timeout 60s`
  - `proxy_read_timeout 60s`
- Separate websocket location shows `proxy_read_timeout 86400`

---

## Stream Endpoint Coverage

### SSE

- API SMR stream proxy: `GET /text/tasks/:taskId/stream`
- API transcription SSE: `GET /.../:id/stream` (SSE controller flow)
- SMR native task stream: `GET /api/v1/tasks/{task_id}/stream` (EventSourceResponse)

### WebSocket

- API STT gateway websocket: `/ws/stt-v2/stream`
- NLP websocket classify endpoints:
  - `/ws/classify/token/{session_id}`
  - `/ws/classify/text/{session_id}`

---

## Findings (Severity Ordered)

### Critical

1. **Stream-init timeout mismatch (`30s` vs queue `60s`)**
   - Gateway can timeout before SMR queue admission completes.
   - Impact: false failure during legitimate high-load periods.

2. **SSE upstream hard stop at `300s`**
   - Long generations may exceed 5 minutes.
   - Impact: truncated streams, inconsistent client outcomes.

### High

3. **Shared proxy defaults at `60s`**
   - Safe for normal HTTP, not safe for long-lived streaming routes.

4. **Deployment template may propagate unsafe stream settings**
   - If `proxy_read_timeout 60s` is used for SSE routes, streams can drop despite app-level heartbeat.

### Medium

5. **STT timeout semantics mismatch**
   - Session inactivity timeout (`60s`) and audio-idle timeout (`300s`) can produce user-visible early session finalization if traffic pattern is sparse.

6. **NLP timeout config/runtime drift**
   - Environment-configured values may not be fully applied due to hard-coded manager constants.

---

## Recommended Timeout Matrix (Target Baseline)

Use endpoint-class policies instead of one global timeout.

| Endpoint class | Gateway timeout | Service timeout | Proxy/LB timeout | Notes |
|---|---:|---:|---:|---|
| Stream-init HTTP (SMR `generate stream=true`) | 90s | queue wait <= 60s | >= 120s | Must exceed queue + network jitter |
| SSE stream relay | >= 900s (or explicit no hard cap policy) | provider cap 120-300s+ | 3600s to 86400s on stream routes | Keep heartbeat <= 15-30s |
| WebSocket streaming | N/A request timeout | heartbeat/ping enforced | > pingInterval + pingTimeout (+ margin) | Avoid proxy idle closure |
| Sync generation HTTP | 120-180s | provider timeout aligned | >= gateway timeout | Keep client timeout >= gateway timeout |

Notes:

- For SSE, favor explicit stream-route-specific proxy timeout policy over global settings.
- Keep heartbeat enabled to keep intermediaries active and detect stale links.
- Align client-side abort windows with gateway policy to avoid premature client cancellation.

---

## Suggested Remediation Direction (Implementation Phase)

1. Introduce dedicated timeout config per endpoint class:
   - stream-init, stream-relay (SSE), sync-generation, websocket control paths.
2. Raise API stream-init timeout above queue max wait with margin.
3. Replace fixed `300s` SSE relay timeout with configurable value aligned to provider and product SLO.
4. Document and enforce reverse-proxy timeout policy for SSE and WS routes separately.
5. Reconcile STT/NLP timeout semantics and remove config/runtime drift.
6. Add integration tests for long-lived stream stability and queue-induced delay behavior.

---

## External Best-Practice Notes

- SSE commonly requires higher `proxy_read_timeout` than default reverse-proxy values; `60s` is usually insufficient for sparse-event streams.
- WebSocket proxy idle timeout should be greater than heartbeat window (`pingInterval + pingTimeout`) to avoid transport-close churn.
- Long-lived Node streaming paths should use explicit timeout strategy rather than relying on defaults.

---

## Sources

### Internal sources

- HOPE codebase files listed in **Method and Files Reviewed**.

### External references

1. [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
2. [Socket.IO reverse proxy guidance](https://socket.io/docs/v4/reverse-proxy)
3. [Node.js HTTP module documentation](https://nodejs.org/api/http.html)
4. [SSE + Nginx operational discussions](https://serverfault.com/questions/801628/for-server-sent-events-sse-what-nginx-proxy-configuration-is-appropriate)

