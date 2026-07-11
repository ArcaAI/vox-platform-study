> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `general-purpose` `aaa7ed54e4f15ffa8` (sub-agent of 11). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# STT Gateway↔Backend Bridge — Research Findings

Repo root: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`. All `.claude/worktrees/**` copies ignored.

## 1. `SttWsGateway` decorator + ticket auth

`@WebSocketGateway({ path: '/ws/stt-v2/stream' })` — `apps/api/src/modules/streaming/stt-ws.gateway.ts:160`.

`handleConnection` (lines 281-425) reads both `sessionId` and `ticket` from the **URL query string**, not a first frame:
```ts
const url = new URL(req.url || '', 'http://localhost');
const sessionId = url.searchParams.get('sessionId');
const ticket = url.searchParams.get('ticket');
```
(lines 282-284)

Ticket validated via `await this.streamTicketService.consumeTicket(ticket)` (line 308).

`StreamTicketService` (`apps/api/src/modules/auth/stream-ticket.service.ts`):
- Redis key: `STREAM_TICKET_KEY_PREFIX = 'stream-ticket:'` (line 24) → `stream-ticket:<ticket>`
- TTL: `STREAM_TICKET_TTL_SECONDS = 30` (line 25)
- Payload (`StoredTicket`, lines 51-58): `{ userId, tenantId, scope, exp, impersonatedBy }`
- Single-use GET+DEL (lines 82-118): `const raw = await this.cache.get(key); ... await this.cache.del(key);` — deletes unconditionally, even for corrupt/expired records ("Best-effort delete to enforce single-use semantics").

Issuance — **two paths**:
1. Inline mint on session create: `TranscriptionJobController.createStreamSession()` (`apps/api/src/modules/streaming/transcription-job.controller.ts:316-407`) — `this.streamTicketService.issueTicket({ userId, tenantId, scope: \`stt_session:${result.sessionId}\` })` (lines 384-388). Route `@Post('stream/session')` on `@Controller('audio/transcription-jobs')` → `POST /api/v1/audio/transcription-jobs/stream/session`. Reconnect refresh at `POST .../stream/session/:sessionId/refresh-ticket` (lines 454-474).
2. Generic endpoint: `AuthController.issueStreamTicket()` — `@Post('stream-ticket')` (`apps/api/src/modules/auth/auth.controller.ts:778`) → confirmed **`POST /api/v1/auth/stream-ticket`**. This generic endpoint also accepts `stt_session:<sessionId>` scopes via `assertSttSessionScopeOwnership` (auth.controller.ts:884-898, TASK-450 C4-01), alongside `consultation_*:<id>` scopes.

Scope check on connect (lines 318-328):
```ts
const expectedScope = `stt_session:${sessionId}`;
if (stored.scope !== expectedScope) { ...close(4401)... }
```
Plus a tenant-binding check (lines 330-354): `boundTenant = await this.sessionBinding.lookup(sessionId)` must `=== stored.tenantId`; a lookup throw also fail-closes.

Every rejection path (missing sessionId/ticket, invalid ticket, scope mismatch, tenant-binding mismatch/missing/error) closes with the identical generic code+reason (lines 29-38):
```ts
export const WS_CLOSE_CODES = { AUTH_FAILED: 4401 } as const;
export const WS_GENERIC_AUTH_REASON = 'Authentication failed';
```
No enumeration signal on the wire; the real cause only reaches the server-side warn log.

## 2. Messages FROM browser + forwarding path

`handleMessage()` (`stt-ws.gateway.ts:796-867`). Binary frames route BEFORE the JSON switch via the `ws` `isBinary` flag (lines 809-813):
```ts
if (isBinary === true) {
  session.binarySeq++;
  const audio = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData));
  this.forwardAudioFrame(session, session.binarySeq, audio);
  return;
}
```
JSON message types (switch on `msg.type`, lines 828-857):
- `'audio'` (829-833): `const data = Buffer.from(String(msg.data), 'base64'); this.forwardAudioFrame(session, seq, data);`
- `'stop'` (836-839): `await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');`
- `'resume'` (841-845): `this.handleResume(session, msg)` — D-17/C3-01 replay handshake.
- `'close'` (847-853): `this.finalizeSession(session, 'session closed by client'); client.close(1000, ...)`
- default → `sendError(client, 'UNKNOWN_TYPE', ...)`.

This is **Redis Streams, not an HTTP call** into stt-v2's `api/routes.py`.

- Gateway send (audio): `forwardAudioFrame()` (`stt-ws.gateway.ts:878-889`) → `StreamingAudioBridgeService.writeAudioFrame()` → XADD to `` `stt:audio:${sessionId}` `` (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:232-267`, key at line 244).
- stt-v2 receive (audio): `IngestionConsumer._run()` (`apps/stt-v2/src/stt_v2/streaming/redis_streams.py:303-388`) `xreadgroup`s `audio_stream_key(session_id)` = `f"stt:audio:{session_id}"` (lines 67-69, 305, 321-327) → `_dispatch_frame` → `AudioFrame.from_redis_dict(fields)` → `on_frame`, wired by `SessionManager.create_session()` to `self._make_frame_handler(session, preprocessor)` (`apps/stt-v2/src/stt_v2/streaming/session_manager.py:610-616`).
- Control: gateway `writeControlCommand()` XADDs `{action}` to `` `stt:control:${sessionId}` `` (streamingAudioBridge.service.ts:279-293, key line 284); stt-v2 `ControlListener._run()` XREADs `control_stream_key(session_id)` = `f"stt:control:{session_id}"` (redis_streams.py:77-79, 540-548) → `on_control` → `SessionManager._make_control_handler` (session_manager.py:1746-1810) — FINALIZE runs `session.finalize()` + `publisher.publish_status("finalizing")`, then `_flush_final_utterance` / `_drain_inference_queue` / `_finalize_session`.

## 3. Results consumption

Redis Streams **consumer group** via `XREADGROUP`, in `StreamingAudioBridgeService.readResultStream()` (`streamingAudioBridge.service.ts:426-527`).

- Stream key: `` const streamKey = `stt:result:${sessionId}`; `` (line 319) — matches stt-v2's `result_stream_key()` = `f"stt:result:{session_id}"` (redis_streams.py:72-74).
- Consumer group: default unique-per-subscription `` `${RESULT_CONSUMER_GROUP_PREFIX}-${this.nextSubscriptionId()}` ``, `RESULT_CONSUMER_GROUP_PREFIX = 'stt-bridge'` (lines 31, 326); the WS gateway passes a **stable** group `'captions'` — `WS_RESULT_CONSUMER_GROUP = 'captions'` (stt-ws.gateway.ts:103) via `{ consumerGroup: WS_RESULT_CONSUMER_GROUP }` (stt-ws.gateway.ts:436).
- BLOCK: `RESULT_STREAM_BLOCK_MS = 500` ms (streamingAudioBridge.service.ts:12). Exact call (lines 455-466):
```ts
const result = (await reader.xreadgroup(
  'GROUP', group, consumer, 'COUNT', 100, 'BLOCK', RESULT_STREAM_BLOCK_MS,
  'STREAMS', streamKey, readId,
)) ...
```
`readId` is `'0'` (drain own PEL) until empty, then `'>'` (live) — lines 453, 469-471.
- XACK: `await reader.xack(streamKey, group, ...ackIds)` **after** emitting each entry (lines 487-488, 496-497) — at-least-once.
- XAUTOCLAIM (dead-consumer handoff): `reclaimResultPending()` (lines 550-578): `reader.xautoclaim(streamKey, group, consumer, RESULT_CLAIM_MIN_IDLE_MS, '0-0', 'COUNT', 100)`, `RESULT_CLAIM_MIN_IDLE_MS = 30_000` (line 50).
- Group create: `reader.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM')`, swallows `BUSYGROUP` (lines 530-541).

## 4. `parseAndEmitResult` — full behavior + diff

Status literals recognized (only under `data.type === 'status'`): `closed`, `cancelled` = **terminal** (stop reader); `finalizing` = explicitly **non-terminal** (progress marker, skipped, reader continues); any other status string also falls through to non-terminal. Current code (streamingAudioBridge.service.ts:622-633):
```ts
private parseAndEmitResult(subject: Subject<StreamingTranscriptMessage>, fields: string[]): boolean {
  const data: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    data[fields[i]] = fields[i + 1];
  }
  // Terminal only on a true end-of-session status. `finalizing` is a progress
  // marker that PRECEDES the tail final — treating it as terminal drops it.
  if (data.type === 'status') {
    return data.status === 'closed' || data.status === 'cancelled';
  }
  // ...else builds a `transcript` message via subject.next({...}); returns false
}
```
Caller (lines 480-493) completes the subject only when this returns `true`:
```ts
const terminal = this.parseAndEmitResult(subject, fields);
if (terminal) {
  if (ackIds.length > 0) { await reader.xack(streamKey, group, ...ackIds).catch(() => {}); }
  subject.complete();
  return;
}
```

**Git diff (commit `0040fe3e`) — `streamingAudioBridge.service.ts`:**
```diff
@@ -483,7 +483,7 @@
               const terminal = this.parseAndEmitResult(subject, fields);
               if (terminal) {
-                // Ack what we saw, then complete on closed/finalizing.
+                // Ack what we saw, then complete on the terminal status (closed/cancelled).
                 if (ackIds.length > 0) {
@@ -608,8 +608,16 @@
   /**
    * Parse one result-stream entry's flat field array and emit it on `subject`.
-   * Returns `true` when the entry is a terminal status (closed/finalizing) so
-   * the caller completes the stream. (Parsing unchanged from the XREAD path.)
+   * Returns `true` when the entry is a TERMINAL status (`closed`/`cancelled`)
+   * so the caller completes the stream. (Parsing unchanged from the XREAD path.)
+   *
+   * `finalizing` is NOT terminal: stt-v2 publishes it as a progress marker
+   * BEFORE it flushes the tail utterance, so the result-stream order is
+   * `finalizing → FINAL → closed` (session_manager `publish_status("finalizing")`
+   * precedes `_flush_final_utterance`). Completing on `finalizing` would tear the
+   * reader down one entry too early and orphan the closing final in Redis — the
+   * session's last spoken utterance would never reach the client. Non-terminal
+   * status entries are skipped (never emitted) and the reader keeps reading.
    */
   private parseAndEmitResult(...): boolean {
     ...
-    // Check if this is a status entry (session closed)
+    // Terminal only on a true end-of-session status. `finalizing` is a progress
+    // marker that PRECEDES the tail final — treating it as terminal drops it.
     if (data.type === 'status') {
-      return data.status === 'closed' || data.status === 'finalizing';
+      return data.status === 'closed' || data.status === 'cancelled';
     }
```
Root cause: pre-fix, `finalizing` was terminal, so the reader completed/unsubscribed the instant it saw the `finalizing` status entry — one entry before stt-v2's tail FINAL segment (stt-v2 publishes FINAL *after* `finalizing`; `SessionManager._make_control_handler`, session_manager.py:1762-1766: `session.finalize()` → `publisher.publish_status("finalizing")` → later `_flush_final_utterance` publishes the real FINAL). That tail final was orphaned in Redis, never relayed — the P0 bug.

## 5. `redis_streams.py` / `_runtime.py` — before/after diff

**`redis_streams.py` — `IngestionConsumer._run` (audio ingestion):**
```diff
+from redis.exceptions import TimeoutError as RedisTimeoutError
...
                         block=self._block_ms,
                     )
+                except RedisTimeoutError:
+                    # A redis-py socket_timeout shorter than BLOCK surfaces here
+                    # every time the block elapses on a SILENT stream (a speech
+                    # pause, or the quiet tail while the session finalizes). No
+                    # entry was delivered, so it is BENIGN — treat it exactly like
+                    # an empty read and re-issue immediately. ... Deliberately NOT
+                    # the fatal-error path below: no error spam, no 1s backoff.
+                    continue
                 except Exception as exc:
                     if _err_has(exc, "NOGROUP"):
```

**`redis_streams.py` — `ControlListener._run` (control commands):**
```diff
                         block=self._block_ms,
                     )
+                except RedisTimeoutError:
+                    # Benign: a socket_timeout shorter than BLOCK elapsed on a
+                    # quiet control stream. Re-issue with the same last_id ...
+                    # Not an error, no backoff; otherwise the 1s backoff + error
+                    # spam would delay the very finalize command that ends the
+                    # session.
+                    continue
                 except Exception as exc:
                     logger.error(
                         "Control XREAD failed, retrying",
```
Both `except RedisTimeoutError: continue` blocks sit BEFORE the generic `except Exception as exc:` fallback (which does `logger.error(...)` + `await asyncio.sleep(1)`). Confirmed post-fix: no error-level log, no backoff — a silent `continue` straight back to the loop top, re-issuing the blocking read immediately. Live in current file at redis_streams.py:328-340 (Ingestion) and redis_streams.py:549-557 (Control).

**`_runtime.py` — `health_check_interval`:**
```diff
+        # NOTE on timeouts: ... We deliberately do NOT force a socket_timeout
+        # here — a socket_timeout shorter than BLOCK would raise on every
+        # silence gap. Any socket_timeout supplied via REDIS_URL is now
+        # tolerated gracefully by those readers ... health_check_interval lets
+        # redis-py detect a silently-dropped connection on the next idle
+        # command rather than hanging indefinitely.
         _redis_client = aioredis.from_url(
             settings.redis_url,
             decode_responses=False,  # Streams use binary data
+            health_check_interval=30,
         )
```
`health_check_interval=30` set on the dedicated streaming `aioredis.from_url(...)` client in `initialize_streaming()`, `apps/stt-v2/src/stt_v2/streaming/_runtime.py:102-106`.

Files touched in `0040fe3e` (`git show --stat`): `_runtime.py` (+10), `redis_streams.py` (+23), `tests/unit/streaming/test_stream_hygiene.py` (+101, new `TestBlockingReadTimeoutTolerance` class — verified live at test_stream_hygiene.py:232-326, asserting `mock_logger.error.call_count == 0` on the benign-timeout path), `docs/implementation/TASK-471-Tentative-Tail-Render/README.md` (+19), `streamingAudioBridge.service.test.ts` (+30/-1), `streamingAudioBridge.service.ts` (per hunks above). Commit message: "Long-standing since the initial commit — NOT a TASK-471 regression." Live verification cited: whisper-large-v3-turbo, medical_wer 0.03–0.07, keyterm_recall 1.0, audio_coverage 0.994–0.997, 0 redis timeout errors across 3 clinical clips.

## 6. WS gateway heartbeats/timeouts

**Not found**: no ping/pong interval, no idle-connection timeout, no max-session-duration constant in `stt-ws.gateway.ts` or `streaming.module.ts`. `apps/api/src/main.ts:61`: `app.useWebSocketAdapter(new WsAdapter(app) as any);` — no options object, so no custom keepalive at the adapter level either.

Adjacent (not a true heartbeat): `WS_RESUME_GRACE_MS = 15_000` (15s default, override `STT_WS_RESUME_GRACE_MS`) — stt-ws.gateway.ts:83-93 — a post-disconnect grace window before the upstream STT-v2 session finalizes, not an idle-while-connected timeout. Also an unrelated internal 20,000ms `socketHeartbeat` interval (lines 179, 203) that republishes this instance's open-socket count to a Redis registry — not a client ping/pong.

## 7. `stt-internal.controller.ts`

`apps/api/src/modules/internal/stt-internal.controller.ts`. Class decorators (lines 16-20): `@ApiTags('internal-stt') @ApiExcludeController() @ApiSecurity('api-key') @Authorize() @Controller('internal/stt')`.

Endpoints (all call `this.ensureInternalApiKey(request)` first):
- `POST /internal/stt/transcripts` (34) → `createTranscript` — create transcript context item from STT worker output.
- `PATCH /internal/stt/jobs/:id/start` (41) → `startJob`.
- `PATCH /internal/stt/jobs/:id/progress` (49) → `updateProgress`.
- `PATCH /internal/stt/jobs/:id/complete` (57) → `completeJob`.
- `PATCH /internal/stt/jobs/:id/fail` (65) → `failJob`.
- `GET /internal/stt/jobs/:id/status` (73) → `getJobStatus` — lightweight worker-polling status.
- `POST /internal/stt/audio-records` (81) → `createAudioRecord`.
- `POST /internal/stt/media` (89) → `createMedia` — TASK-334 I-2b, registers a stored object as a Media row (dual-capture).

Auth: **not literally `X-Service-Token`** (that convention governs gateway→python, the opposite direction). Actual chain: class-level `@Authorize()` (line 19) requires the global `UnifiedAuthGuard` pipeline to pass, plus a manual per-handler guard (lines 28-32):
```ts
private ensureInternalApiKey(request: RequestWithAuth): void {
  if (!request.apiKey) {
    throw new UnauthorizedException('Internal STT endpoints require API key authentication');
  }
}
```
`request.apiKey` is populated by `UnifiedAuthGuard`'s API-key path (`apps/api/src/types/request-with-auth.ts:12`: "set by `UnifiedAuthGuard` after a successful [...] auth"). The Python caller (`APIGatewayClient.__init__`, `apps/stt-v2/src/stt_v2/core/api_client/gateway.py:26-39`) sends header `X-Internal-Service-Key: <api_key>`. Verified: `ApiKeyService.extractApiKeyFromRequest` (`packages/applications/src/services/apiKey/apikey.service.ts:887-891`) checks headers in order `apikey`, `api-key`, `x-api-key`, `x-internal-service-key` — so `X-Internal-Service-Key` is accepted, just under the generic API-key mechanism, not the `X-Service-Token` shared-secret constant-time-compare middleware documented for the outbound direction. `@ApiSecurity('api-key')` is Swagger-doc-only.

## 8. Audio wire format

Browser→Gateway: either a raw binary WS frame (bytes forwarded as-is) OR JSON `{type:'audio', seq, data:<base64>}` decoded via `Buffer.from(String(msg.data), 'base64')` (stt-ws.gateway.ts:831, 811). Both are treated as raw PCM16LE — the gateway hardcodes `writeAudioFrame(..., 'pcm_s16le', false)` (stt-ws.gateway.ts:879); it does not read an encoding hint from the client message.

Gateway→stt-v2 (XADD fields, streamingAudioBridge.service.ts:246-266):
```ts
await this.writerRedis.xadd(
  streamKey, 'MAXLEN', '~', String(AUDIO_STREAM_MAXLEN), '*',
  'seq', String(seq), 'sr', String(sampleRate), 'enc', encoding, 'ch', '1',
  'data', data, 'final', isFinal ? '1' : '0', 'ts', String(Date.now() / 1000),
);
```
`data` is the raw Buffer (binary Redis Stream field, not re-encoded). `AUDIO_STREAM_MAXLEN = 10000` (line 20).

stt-v2 decode: `AudioFrame.from_redis_dict()` (`apps/stt-v2/src/stt_v2/streaming/schemas.py:83-121`) — `enc = AudioEncoding(_str(_get("enc")))`, `AudioEncoding` (schemas.py:20-24) is `PCM_S16LE = "pcm_s16le"` / `PCM_F32LE = "pcm_f32le"`; `data = raw_data if isinstance(raw_data, bytes) else raw_data.encode()` (line 109) — raw bytes, "NOT base64" per the dataclass docstring (schemas.py:63).

## 9. Chunk cadence / batching thresholds

**Not found** at the intended level — no producer-side minimum-bytes-before-processing or explicit batching window at the gateway or stt-v2 ingestion boundary; every WS audio frame received is forwarded via one XADD each (no coalescing in `forwardAudioFrame`/`writeAudioFrame`).

Closest related constants (reader-side batching, not producer cadence):
- `IngestionConsumer` XREADGROUP: `count=100, block=self._block_ms`, constructor default `block_ms: int = 5000` (redis_streams.py:143), not overridden by `SessionManager.create_session()`'s `IngestionConsumer(...)` call (session_manager.py:610-616) — audio reads use the 5000ms/100-entry default.
- Partial-hypothesis emit cadence: `streaming_partial_interval_s` default `0.4` (400ms) — session_manager.py:166-169 ("TASK-471 A1 — lowered, configurable partial-emit cadence").
- Audio-stream `XTRIM` throttle: `streaming_audio_trim_interval_s` default `30.0`s (session_manager.py:170-172; settings.py:486-493) — hygiene trimming, not an ingestion gate.

## 10. `commit_policy.py` triggers

Important distinction: `LocalAgreementPolicy` does **not** decide when a segment/utterance finalizes. It's a pure text-stabilization policy over already-final-vs-partial ASR hypotheses (commit_policy.py:12: "The policy is pure (no I/O, no session knowledge)"). It runs LocalAgreement-2: compares the current partial hypothesis to the previous one token-by-token (case/punctuation-normalized), freezing a "committed" prefix that only grows while agreement holds and rolls back on contradiction (`update()`, lines 61-116); `reset()` (118-123) clears state per final. Its output (`stable_chars = len(committed)`) is purely a UI-stabilization hint on partials (session_manager.py:1598-1606).

Actual finalization is VAD-driven, via config built in `session_manager._build_preprocessor_vad_kwargs()` (lines 214-249) — both silence-based and time-based:
- **Silence-based**: `min_silence_duration_ms` — pipeline-YAML `vad_cfg.min_silence_duration_ms` if configured, else `self._profile.vad_silence_threshold_ms`. Real hardware-profile default confirmed in `execution_profile.py`: `vad_silence_threshold_ms=500` (ms) on every profile (lines 163, 189, 213, 248, 289) — matches the session_manager.py docstring: "min_silence_duration_ms follows the hardware profile (500 ms on every profile) instead of the preprocessor's legacy hardcoded 700 ms (H4 — shaves ~200ms off every final's latency floor)."
- `min_speech_duration_ms`, `threshold` (VAD probability) — pipeline-YAML-only.
- **Time-based force cap**: `max_utterance_duration_ms` ← `vad_cfg.force_emit_after_ms` (pipeline-config-gated, no universal hardcoded default found) — forces emission regardless of continued speech/silence.
- `force_emit_lookback_ms` / `force_emit_overlap_ms` — windowing around a forced emit.
- Always wired regardless of YAML: `partial_window_s` (default `8.0`) and `partial_interval_s` (default `0.4`s) — govern the partial decode window/cadence, not the final-vs-partial decision.

So: finalization is VAD-silence-triggered by default (500ms), with an optional pipeline-configurable time-based force-emit ceiling; `commit_policy.py` is orthogonal — it only governs the "stable prefix" annotation on partials, not when a final happens.
