# 19. WebSocket Gateways

**Sources:** [`apps/api/src/modules/streaming/stt-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts), [`apps/api/src/modules/speech/tts-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/tts-ws.gateway.ts), [`apps/api/src/modules/streaming/workflow-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/workflow-ws.gateway.ts), [`apps/api/src/bootstrap/ws-gateway-owner-audit.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/ws-gateway-owner-audit.ts), [`apps/api/src/modules/auth/stream-ticket.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/auth/stream-ticket.service.ts)

Three WebSocket gateways are registered in the gateway process. Each is classified in `WS_OWNER_BOUND_GATEWAYS` (boot-audited).

## Overview

| Gateway | Path | Owner binding | Auth model | Notes |
|---|---|---|---|---|
| `SttWsGateway` | `/ws/stt/stream` | `enforced` | Single-use stream ticket scoped `stt_session:<sessionId>`, consumed on handshake. Session has server-side binding (tenant + owner). Owner check enforced at handshake and on rebind. | Long-lived streaming session; resume/grace window; supersession codes; tenant lock enforcement; origin gate. |
| `TtsWsGateway` | `/ws/tts/stream` | `no-owned-session` | Single-use stream ticket scoped `tts_session:<sessionId>`, consumed on handshake. Ticket minted bound to active tenant. No server-side owned session resource. | Bridges browser WS to upstream TTS WS; CSWSH origin gate before ticket parsing; quota pre-flight; injects agent spec/provider overrides; usage metering; backpressure. |
| `WorkflowWsGateway` | `/ws/workflows` | `no-owned-session` | Single-use stream ticket scoped `workflow_run:<runId>`, consumed on handshake. Ticket bound to tenant at mint; run ownership checked via `getRunStatus` under ticket tenant. | Mirrors SSE `/workflows/{slug}/runs/{runId}/stream`; supports legacy and run-protocol v2 frames; backpressure (R-9); resync on evicted cursor; entry gate check. |

## Common Posture

- **No JWT in URL**: All use single-use stream tickets issued via `POST /auth/stream-ticket`.
- **Enumeration resistance**: Handshake failures collapse to generic close codes/reasons (e.g., STT/TTS `4401 Authentication failed`) so clients cannot probe sessions/tickets/scopes.
- **CSWSH/origin enforcement**: STT and TTS and Workflow apply origin checks when enforcement enabled; behavior aligned with HTTP CORS posture (fail-closed on unavailable/empty registry).
- **Correlation**: Propagate trace context and `X-Request-Id` to upstream hops where applicable.
- **Boot audit**: `auditWebSocketGatewayOwnerBinding` refuses to start if any `@WebSocketGateway()` class is unclassified.

## STT Gateway (`/ws/stt/stream`) Details

From [`apps/api/src/modules/streaming/stt-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts):

- **Close codes:** `4401` (auth failed), `4409` (session superseded/takeover), `4423` (tenant locked). Generic reason `Authentication failed` for auth failures.
- **Handshake checks (in order):** origin gate (if browser origin present) → require `sessionId` and `ticket` → consume ticket (`consumeTicket`) → verify scope `stt_session:<sessionId>` → load session binding via `StreamSessionBinding`/`StreamSessionTenantBindingService` and verify tenant matches ticket, owner (`userId`) matches ticket user (fail-closed) → tenant lock check (`TenantLockService`) → register socket, bind to session, subscribe to results.
- **Ownership:** Session owned by specific user; takeover by owner on new socket closes superseded socket with `SESSION_SUPERSEDED`. Owner check enforced at handshake and on rebind.
- **Resume/grace:** Session kept alive briefly on disconnect for resume; bounded resume buffer and audio clock samples.
- **Backpressure/metrics:** Egress watermark, dropped partial/final metrics, commit/first-partial latency metrics.
- **Integration:** Talks to STT service/v2 paths; mirrors transcripts; handles usage/events.

## TTS Gateway (`/ws/tts/stream`) Details

From [`apps/api/src/modules/speech/tts-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/tts-ws.gateway.ts):

- **Close codes:** `4401` (auth), `1011` (upstream error), `4429` (quota exceeded). Generic auth reason for handshake failures.
- **Handshake checks:** origin gate **before** ticket parsing/sessionId handling → require `sessionId` and `ticket` → consume ticket → verify scope `tts_session:<sessionId>` → **pre-flight quota** via `EntitlementsService.assertMeterQuota(tenantId, 'monthlyTtsCharacters', 0)` (if over limit, close `4429` Quota exceeded) → open bridge.
- **No owned session resource:** Ticket is whole authorization; tenant comes from ticket.
- **Bridge behavior:** Opens upstream WS to `TTS_URL` (converted to ws://) with headers including trace context, `X-Request-Id`, `X-Tenant-Id` (if present), and `X-Service-Token` from `INTERNAL_ACCESS_TOKEN` (shared token). Injects resolved TTS agent spec and provider overrides from `TtsAgentResolverService`/`resolveTtsRequestConfig`. Relays frames verbatim (binary passthrough), applies client-side backpressure (pause upstream when client bufferedAmount exceeds watermark), meters usage from upstream frames, logs/metrics.
- **Backpressure:** `TTS_WS_EGRESS_HIGH_WATERMARK_BYTES` (default 512KiB), poll-based drain.

## Workflow Gateway (`/ws/workflows`) Details

From [`apps/api/src/modules/streaming/workflow-ws.gateway.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/workflow-ws.gateway.ts):

- **Close codes:** `4401` (auth), `4400` (unsupported protocol/cursor), `1011` (stream setup unavailable). Generic auth reason.
- **Handshake checks:** origin gate (if browser origin) → validate protocol/cursor (`resolveRunProtocol`/`parseClientCursor`) **before** consuming ticket → require `slug`, `runId`, `ticket` → consume ticket → verify scope `workflow_run:<runId>` → ticket must have tenantId → load run status via `WorkflowExposureService.getRunStatus(slug, runId)` under CLS context with ticket tenant/user (and `runReader` if present). On 404/lookup failure, generic close.
- **Entry gate:** If `WorkflowEntryGateService` present, check `assertEntryAllowed(slug, workflowVersionNumber, 'socket')`; refusal closes `4400` with `MODE_UNSUPPORTED` (read failures close `1011`).
- **Delivery:** Uses shared `RunEventStreamHub` + `deliverRunEvents` (shared with SSE). Supports protocol v2 (bare envelopes, resumed with `?after=<seq>`, ping/resync) and legacy `{event,id,data}` frames derived from v2. Snapshot-then-delta, backpressure (R-9) via `beforeRead` awaiting buffer below threshold, terminal recheck, heartbeat.
- **Resync:** If cursor evicted from producer MAXLEN, resync snapshot then retained events.

## References
- [apps/api/src/bootstrap/ws-gateway-owner-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/ws-gateway-owner-audit.ts)
- [apps/api/src/modules/auth/stream-ticket.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/auth/stream-ticket.service.ts)
- [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)
