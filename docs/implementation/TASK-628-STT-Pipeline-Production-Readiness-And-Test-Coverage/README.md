# TASK-628 — Speech-to-Text Pipeline: End-to-End Review, Production Readiness & Test Coverage

| Field | Value |
|---|---|
| **Status** | Closed |
| **Classification** | feature / infrastructure |
| **Created** | 2026-08-07 |
| **Owner** | Platform / STT |
| **Parent context** | [`TASK-616 Appendix G`](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) — §G2 (WebSocket & SSE), §G3 (Redis Streams), §G7 (probes/PDB/HPA), §G9 (ranked remediation) |
| **Blocks** | Entry of the STT pipeline into the automated CI/CD promotion flow (TASK-616) |

> **Relationship to TASK-616.** Appendix G established *what breaks during a deploy*, platform-wide.
> This ticket takes one pipeline — speech-to-text, browser mic to rendered caption — traces it
> end-to-end with citations, and defines **the test suite that must be green before the pipeline is
> allowed into automated promotion**. Appendix G findings are referenced, never restated. Where this
> document disagrees with or extends Appendix G, it says so explicitly.

---

## 1. Requirement Analysis

### 1.1 The owner's requirement, restated

> *Everything must be production-ready before moving to CI/CD, and tests must cover real
> production / real-use-case situations.*

Two claims are embedded in that sentence and they are separable:

1. **Production-readiness** — the pipeline must survive the events that a CI/CD promotion flow
   *causes*: pod restarts, rolling updates, image swaps, config reloads. A promotion pipeline that
   automatically deploys a system which loses 20–35 s of clinical speech per deploy is a machine for
   generating clinical incidents at a higher rate than a human doing it manually.
2. **Test coverage of real situations** — the gate must be *evidence*, not *assertion*. Today the
   only STT tests that hard-block a merge are unit tests with a mocked Redis
   (`docs/operations/testing/ci-gates.md`, "Test stage" table). Every test that touches a real socket,
   a real Redis, or a real STT worker is either `allow_failure: true` or behind an opt-in flag.

### 1.2 Scope

**In scope**

- The live streaming path only: browser microphone → `@arcaai/room` → VAD/noise filter →
  `StreamingBackendSTTProvider` → `SttWebSocketClient` → `SttWsGateway` → `StreamingAudioBridgeService`
  → Redis Streams → `apps/stt` `SessionManager` → inference → result stream → bridge → gateway → SDK
  store → UI.
- Session identity, ticket auth, resume, backpressure, ordering, idempotency, and shutdown behaviour
  at every hop.
- The test strategy (unit / integration / E2E / chaos) and the CI gate definition.

**Out of scope**

- Batch transcription (`TranscriptionJob`, TASK-603/604) — a different durability model; its
  Dramatiq/Redis redelivery already gives at-least-once and it has no live socket.
- ASR *quality* (WER/CER). TASK-594 owns that; the quality scorecard
  (`apps/stt/tests/integration/test_streaming_quality_scorecard.py`) stays where it is.
- The k8s manifest changes themselves (probe paths, tGPS, `preStop`) — those are TASK-616 §G9 items
  #1, #2, #6. This ticket *depends* on them and *tests* their effect.

### 1.3 Success criteria

| # | Criterion |
|---|---|
| AC-1 | The end-to-end trace in §2 exists, with `path:line` citations, and every state-holding location and silent-drop point is enumerated. |
| AC-2 | Every gap in §2.4 is either fixed, or has a recorded, owner-signed waiver naming the accepted clinical risk. |
| AC-3 | The test matrix in §4 is implemented, and the "Gate" column tests run in CI as **blocking**. |
| AC-4 | A pod restart mid-consultation loses **zero** finalized transcript and ≤ 1 partial, verified by an automated test that fails today. |
| AC-5 | A Redis restart mid-consultation has a documented, tested outcome — either survival, or a hard, observable, non-silent failure. Silent loss is not an acceptable outcome. |
| AC-6 | §6 gate definition is added to `docs/operations/testing/ci-gates.md` as a named job set. |

---

## 2. Current State Evaluation

### 2.1 End-to-end trace

Each hop lists **what holds state**, **what happens on a restart**, and **where data can vanish**.

#### Hop 1 — Microphone capture (browser)

| | |
|---|---|
| **Code** | `packages/stt/src/core/audioCapture.ts:91-111` (`createAudioCapture`) |
| **Framing** | `AudioWorkletNode` coalescing to `frameMs` ≈ 80 ms (`audioCapture.ts:58-62`); fallback `ScriptProcessorNode` at `SCRIPT_PROCESSOR_BUFFER_SIZE = 4096` (`audioCapture.ts:20`, `:177`) |
| **State** | None persistent. `AudioContext` + worklet only. |
| **Drop points** | None at this layer — every frame invokes `onFrame`. |

`@arcaai/room` is graph wiring, not buffering: `AudioTrack` wraps `getUserMedia` and one
`TrackProcessor` (`packages/room/src/core/AudioTrack.ts:132-173`, `:281-324`);
`ProcessorPipeline.buildPipeline` (`packages/room/src/core/ProcessorPipeline.ts:168-196`) chains
processors by priority; `AudioMixer` is GainNode summation with `1/sqrt(N)` normalisation
(`packages/room/src/core/AudioMixer.ts:98-117`, `:340-344`). **No frame-level buffer or drop exists in
`room`** — which matters, because it means there is nowhere upstream that could absorb a transport
outage.

#### Hop 2 — VAD gate → provider

`STTProcessor.setupAudioCapture` (`packages/stt/src/core/STTProcessor.ts:813-826`) is the actual
`onFrame` callback. It **silently skips** the frame when `features?.vadGate` says so
(`STTProcessor.ts:820-822`) — correct by design, but it is the first of several silent skips and it
shares no counter with the others. Otherwise it calls
`provider.processAudio(frame, audioContext.sampleRate)` (`STTProcessor.ts:824`).

`AudioBufferManager` (`packages/stt/src/core/AudioBufferManager.ts:43-48`, `:138-162`) — 30 s chunks,
5 s overlap — is used **only by `LocalSTTProvider`** (`packages/stt/src/providers/LocalSTTProvider.ts:17,68,113,291`).
The streaming path has no equivalent.

#### Hop 3 — `StreamingBackendSTTProvider` ⟶ **the primary data-loss site**

```ts
// packages/stt/src/providers/StreamingBackendSTTProvider.ts:292-296
async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
  if (!this.processing || !this.wsClient.isConnected()) {
    return;                       // ← audio is DISCARDED, not queued
  }
```

The deprecated `BackendSTTProvider` (`packages/stt/src/providers/BackendSTTProvider.ts`) carried a
real `audioQueue`; the live provider does not. This is Appendix G2's "microphone keeps recording and
the audio is silently discarded", located precisely.

Backpressure *drops* (socket over watermark) are handled well by comparison: counted
(`StreamingBackendSTTProvider.ts:305`), pushed via `onDropCallback`
(`:308`, registration `:403-410`), exposed in stats as `droppedFrames` (`:375`), and surfaced to the
store as `markAudioLost()` (`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:641-644`).
**Disconnect drops get none of that treatment** — no counter, no callback, no store signal.

#### Hop 4 — `SttWebSocketClient` (transport)

| Concern | Implementation |
|---|---|
| Send | `sendAudioFrame` (`packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts:430-438`) |
| Backpressure | `shouldDropForBufferedAmount` (`:1206-1210`); default watermark 1 MiB (`:169`) |
| Reconnect | `attemptReconnect` (`:735-819`); exponential + 50 % jitter, cap 30 s (`:759-761`); `maxAttempts` default 5 (`:270`) — **`PluginManager` passes no override** (`packages/agentic-sdk-v2/src/core/PluginManager.ts:795-804`) |
| Ticket re-mint | before every reopen (`:781-797`); a failed refresh **aborts the whole reconnect chain** (`:786-796`) |
| Resume | handshake sent only when `wasReconnecting` (`:367-369`); `{type:'resume', sessionId, lastSeq}` (`:1259-1275`) |
| Resume failure | `buffer_overflow` → recoverable; **any other reason → `onReconnectFailedCb()`** (`:1143-1145`) |

`onReconnectFailed` lands at `PluginManager.ts:814` → `onSttConnectionState('error')` →
`useArcaAudio.ts:649-651` → `store.setSttConnectionState('error')`. **There is no code path that
creates a replacement session.** The SDK's own comment at `SttWebSocketClient.ts:1136-1142` says the
higher layer "tears this session down and establishes a fresh one" — it does not. That is the second
half of Appendix G2's "then it stops permanently".

Session lifecycle REST (`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`):
`createSession` `:93-147` and `refreshTicket` `:204-226` have **no retry on 5xx** (`:135-146`) — a
rolling update returns exactly 502/503 for a few seconds.

#### Hop 5 — `SttWsGateway` (apps/api) ⟶ **the structural blocker**

```ts
// apps/api/src/modules/streaming/stt-ws.gateway.ts:176,183
private readonly sessions      = new Map<WebSocket, SessionInfo>();
private readonly sessionsById  = new Map<string, SessionInfo>();
```

Everything that makes resume work — the 200-entry `resumeBuffer` (`:47`), `resultSeq`, the live
`resultSubscription`, `sampleRate`, tenant — lives in that `Map`. It is **per-process**.

Handshake gate (all failures collapse to a single generic `4401` so sessions cannot be enumerated,
`:28-37`): origin registry, fail-closed (`:341-377`, `:393-401`) → `sessionId` (`:412-418`) → ticket
consume (`:429-437`) → scope `stt_session:<id>` (`:439-449`) → **session→tenant binding**
(`:458-475`) → sampleRate meta, defaulting to 16000 on any failure (`:480-493`).

Then the fork: `sessionsById.get(sessionId)` hit → `rebindSession` (`:500-504`, `:620-659`); miss →
fresh `SessionInfo` with `freshlyCreated: true` (`:506-523`).

`handleResume` (`:1042-1094`) rejects with `resume_failed: unknown_session` when
`session.freshlyCreated && lastSeq > session.resultSeq` (`:1066-1075`). This guard is **correct** —
it prevents the far worse false-resume — but on a different pod it is the *only* possible outcome,
and the client treats it as terminal (Hop 4). **Cross-pod resume is not degraded; it is structurally
impossible.**

Disconnect: unsubscribe the captions reader immediately (`:868-869`), arm a 15 s grace timer
(`:875-880`; `WS_RESUME_GRACE_MS` `:89-92`). Shutdown:

```ts
// stt-ws.gateway.ts:236-254 (onModuleDestroy)
for (const session of [...this.sessionsById.values()]) {
  if (session.graceTimer) { clearTimeout(session.graceTimer); ... }   // grace window CANCELLED
  session.finalizing = true;
  ...
  removals.push(this.sessionService.removeSession(session.sessionId).catch(() => {}));
}
```

The grace window is *cancelled*, not honoured; no `server_draining` frame is sent; no close code
1001/1012 is used; `handleConnection` (`:379`) never consults any `isShuttingDown` flag, so the pod
keeps accepting new sessions while it dies.

Egress backpressure is well built and has one live defect. Over the 512 KiB watermark (`:61-64`),
partials are dropped before seq-tagging (`:679-688`) and finals are queued bounded at 200 (`:72`,
`:724-744`); on overflow the oldest final is dropped and an explicit gap marker is emitted
(`:752-764`) *"so the loss is never silent"*. **But `{type:'gap'}` has no case in the SDK's
`handleMessage` switch** — it falls to `default:` and is logged as "Unknown WebSocket message type"
(`SttWebSocketClient.ts:1181-1186`). The anti-silence mechanism is itself silent.

Audio ingress is fire-and-forget by design (`:1014-1026`) — ioredis preserves per-connection command
order, so ordering holds; failures increment `droppedAudioFrames` and emit `BRIDGE_ERROR`.

#### Hop 6 — `StreamingAudioBridgeService` (Redis Streams)

| | |
|---|---|
| Audio write | `writeAudioFrame` → `XADD stt:audio:{id} MAXLEN ~ 10000` (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:233-268`, bound at `:21`) |
| Control | `XADD stt:control:{id}` (`:280-294`) |
| Result read | `XREADGROUP` on `stt:result:{id}`, `COUNT 100 BLOCK 500` (`:452-467`, `:13`) |
| Group | `captions` (stable), from `stt-ws.gateway.ts:102`; others get a unique group so fan-out survives (`:32`, `:327`) |
| Semantics | PEL-first (`'0'` then `'>'`, `:454`), **ack only after emit** (`:496-499`) — genuine at-least-once |
| Dead-reader hand-off | `XAUTOCLAIM` min-idle 30 s (`:551-579`, `:51`) |
| Writer resilience | `maxRetriesPerRequest: null` → a Redis blip *offline-queues* audio in FIFO order (`:147-158`), with throttled degradation logging (`:597-608`) |
| `finalizing` | deliberately **not** terminal (`:662-679`) — it precedes the tail final |

This layer is the strongest in the pipeline. Appendix G3's assessment holds: **the Redis layer is
already cross-pod-ready; only the gateway `Map` is not.**

#### Hop 7 — `apps/stt` `SessionManager`

| | |
|---|---|
| Ingest group | `AUDIO_CONSUMER_GROUP = "stt-ingest"` (`apps/stt/src/stt/streaming/redis_streams.py:45`), consumer = worker id `worker-<uuid8>-<pid>` (`session_manager.py:174`, passed at `:998`) |
| Read | `XREADGROUP ... COUNT 100 BLOCK 5000` (`redis_streams.py:323-329`) |
| Reclaim | `XAUTOCLAIM` min-idle 30 s (`redis_streams.py:249-303`, `:51`), throttled 15 s (`:54`) |
| Session state | in-process `_sessions: dict` (`session_manager.py:176`) + ~12 parallel dicts (`:179-227`) |
| Durable state | Redis hash `stt:session:{id}` via `_persist()` (`session.py:478-483`), throttled 5 s (`session.py:461-471`) |
| Cross-pod takeover | **yes** — `_recover_sessions()` (`session_manager.py:3648-3805`) SCANs `stt:session:*`, checks `EXISTS stt:worker:{id}` (`:3683-3687`, heartbeat TTL 30 s `:241`, interval 10 s), re-claims and rebuilds (`:3690`, `:3715-3723`) |
| Control | `ControlListener` uses **plain `XREAD`**, no consumer group, no ack, in-memory `_last_id` (`redis_streams.py:591-595`, `:634-638`) |
| Finalize order | `finalizing` → tail final → **`closed` published early**, before MinIO/transcript durability (`session_manager.py:3462-3467`, `:3475-3487`) |
| Shutdown | module-level `signal.signal(SIGTERM, ...)` → `raise SystemExit(0)` (`apps/stt/src/stt/main.py:267-273`); lifespan calls `shutdown_streaming()` (`main.py:177-179`); `SessionManager.stop()` drains inference queues (`:744-746`) and `force_persist()`s metadata (`:754-763`) but **does not finalize** — no tail flush, no blob upload, no durable transcript |

The STT service is markedly more restart-tolerant than the gateway. Its weakness is the *control*
stream: a `finalize` or `cancel` published while a consumer is restarting can be missed entirely,
because there is no PEL to recover from.

#### Hop 8 — Result path back to the UI

`ResultPublisher` (`redis_streams.py:398-517`) writes `stt:result:{id}` with `MAXLEN` approximate;
the bridge projects fields explicitly rather than spreading (a PHI-boundary decision,
`streamingAudioBridge.service.ts:610-638`); the gateway tags a monotonic `seq` and buffers 200
(`stt-ws.gateway.ts:815-826`); the SDK tracks `lastReceivedSeq` (`SttWebSocketClient.ts:1099-1101`)
and normalises tolerantly — a missing `is_final` degrades to a partial, never a premature final
(`:889`).

### 2.2 State inventory

| # | State | Location | Survives gateway restart? | Survives STT restart? | Survives Redis restart? |
|---|---|---|---|---|---|
| S1 | `SessionInfo` (resume buffer, seq, subscription) | gateway process `Map` (`stt-ws.gateway.ts:176,183`) | **No** | n/a | n/a |
| S2 | session→tenant binding, session meta | Redis (`StreamSessionTenantBindingService`) | Yes | Yes | **No** |
| S3 | stream ticket (30 s TTL, `stream-ticket.service.ts:25`) | Redis | Yes | Yes | **No** |
| S4 | audio stream `stt:audio:{id}` | Redis, MAXLEN 10000 | Yes | Yes | **No** |
| S5 | result stream + `captions` group cursor | Redis | Yes | Yes | **No** |
| S6 | STT `_sessions` runtime (VAD/denoiser/ASR) | STT process dicts | n/a | **No** — rebuilt cold | n/a |
| S7 | `stt:session:{id}` metadata | Redis, 5 s throttle | Yes | Yes (recovery scan) | **No** |
| S8 | durable transcript / blobs | Postgres + MinIO | Yes | Yes | Yes |
| S9 | refresh tokens | Redis | Yes | Yes | **No — every user is logged out** |

### 2.3 Silent-drop inventory

| # | Where | Citation | Observable today? |
|---|---|---|---|
| D1 | Client discards audio while disconnected | `StreamingBackendSTTProvider.ts:292-296` | **No** |
| D2 | VAD gate skips frame | `STTProcessor.ts:820-822` | No (by design) |
| D3 | Client watermark drop | `SttWebSocketClient.ts:1212-1225` | Yes — counter + push callback |
| D4 | Gateway partial drop under egress backpressure | `stt-ws.gateway.ts:679-688` | Debug log + counter |
| D5 | Gateway final drop on queue overflow | `:724-744` | Error log + gap marker — **but the SDK ignores `gap`** (`SttWebSocketClient.ts:1181-1186`) |
| D6 | Redis MAXLEN eviction of unconsumed audio | `streamingAudioBridge.service.ts:21,247-267` | **No** |
| D7 | STT frame decode failure — logged, acked anyway | `redis_streams.py:223-234`, `:366-368` | Warn log only |
| D8 | Inference queue full → **final utterance dropped** | `session_manager.py:2685-2705` | Metric only |
| D9 | Audio accumulator cap → recording bytes dropped | `session.py:213-223` | Warn once |
| D10 | Capacity guard 503 | `capacity_guard.py:49-74`, `routes.py:149-155` | Yes — HTTP 503 |
| D11 | Permanent transcript persist drop on 4xx | `session_manager.py:3144-3155` | Error log |
| D12 | STT SIGTERM without finalize | `session_manager.py:725-778` | No |

### 2.4 Production-readiness gap table

Ranked by (clinical impact × likelihood during a promotion).

| ID | Gap | Citation | Failure it causes | Sev |
|---|---|---|---|---|
| **G-01** | WS session state is a per-process `Map` | `stt-ws.gateway.ts:176,183` | Any reconnect landing on another pod ⇒ `resume_failed: unknown_session` ⇒ terminal. Cross-pod resume is impossible, not merely lossy. | **P0** |
| **G-02** | `onModuleDestroy` cancels the grace window and finalizes everything | `:236-254` | Even a *same-pod* deploy destroys resumable sessions before the client can come back. No `1001`/`1012`, no drain frame. | **P0** |
| **G-03** | Client discards audio while disconnected | `StreamingBackendSTTProvider.ts:292-296` | 20–35 s of clinical speech lost per gateway restart, unobservably. | **P0** |
| **G-04** | Redis: `--maxmemory 64mb --maxmemory-policy allkeys-lru --appendonly no --save ""` | `infrastructure/docker/docker-compose.yml:180-186` | One session's audio stream at MAXLEN 10000 × ~2560 B/frame ≈ **25 MB** — two concurrent consultations exceed the entire budget, and `allkeys-lru` will evict *refresh tokens, stream tickets, session bindings and consumer groups* to make room. A restart loses S2–S5, S7, S9 at once. | **P0** |
| **G-05** | `unknown_session` is terminal; nothing creates a replacement session | `SttWebSocketClient.ts:1143-1145` → `PluginManager.ts:814` → `useArcaAudio.ts:649-651` | Captions stop permanently; the mic keeps recording into nothing. | **P1** |
| **G-06** | No 5xx retry on `createSession` / `refreshTicket` | `StreamingSessionManager.ts:135-146`, `:204-226`; abort at `SttWebSocketClient.ts:786-796` | A rolling update emits exactly 502/503; one hit aborts the entire reconnect chain. | **P1** |
| **G-07** | `handleConnection` never checks `isShuttingDown` | `stt-ws.gateway.ts:379` | A draining pod accepts brand-new consultations it is about to kill. | **P1** |
| **G-08** | STT `stop()` does not finalize active sessions | `session_manager.py:725-778` | Tail utterance not flushed, blobs not uploaded, durable transcript not written; recovery is *possible* but nothing guarantees a successor worker runs before the audio stream is trimmed. | **P1** |
| **G-09** | Control stream is plain `XREAD`, no group, no ack | `redis_streams.py:591-595`, `:634-638` | A `finalize`/`cancel` published during a consumer restart is lost — the session hangs until the inactivity reaper. | **P1** |
| **G-10** | Gap markers are unhandled by the client | `stt-ws.gateway.ts:752-764` vs `SttWebSocketClient.ts:1181-1186` | The one mechanism designed to make loss non-silent is silent. | **P2** |
| **G-11** | Inference queue overflow drops a *final* | `session_manager.py:2685-2705` | Whole utterance missing from the durable transcript under load; metric only. | **P2** |
| **G-12** | `SSEClient` never sends `Last-Event-ID` | `packages/agentic-sdk-v2/src/core/SSEClient.ts:282-296` | Every SSE reconnect replays the task stream from `0-0`. Appendix G2 fix (3). | **P2** |
| **G-13** | Reconnect depends on a live JWT to mint a ticket | `StreamingSessionManager.ts:204-226`, TTL `stream-ticket.service.ts:25` | Access-token expiry mid-consultation makes reconnect unrecoverable — no re-auth path in the reconnect chain. | **P2** |
| **G-14** | Worker heartbeat TTL 30 s | `session_manager.py:241`, `:3683-3687` | Up to 30 s before a dead worker's session is claimed; the audio stream keeps growing and MAXLEN-evicting meanwhile (D6). | **P2** |
| **G-15** | Decode failures acked and swallowed | `redis_streams.py:223-234`, `:366-368` | A malformed-frame class of bug is undetectable from metrics. | **P3** |
| **G-16** | Sample rate silently defaults to 16000 | `stt-ws.gateway.ts:480-493` | A 48 kHz session after a Redis blip is misdeclared — garbled transcription, no error. | **P3** |
| **G-17** | **No streaming test blocks CI** | `docs/operations/testing/ci-gates.md` | `test-sdk` is `allow_failure`; `test-api-e2e` is opt-in and runs only `tenant-access-control.spec.ts`. Every finding above could regress silently. | **P0 (process)** |

### 2.5 Existing test inventory — what already exists

**Strong (keep, extend):**

| Suite | File | Covers |
|---|---|---|
| SDK transport unit | `packages/agentic-sdk-v2/src/core/__tests__/SttWebSocketClient.test.ts` (~2 600 lines) | connect/timeout, tenant claim, backoff formula + jitter + `maxAttempts`, resume handshake sent only on reconnect, `resume_failed` handling, fresh-ticket-on-reconnect incl. abort, backpressure watermark, `stopAndDrain` incl. quiet window + concurrent join |
| Gateway unit | `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts` | handshake incl. generic 4401 + tenant binding, grace window, Buffer-text control frames, reconnect-after-drop resume (L1039), false-resume prevention F-06 + binding cleanup F-36 (L1104), egress backpressure (L1271), `onModuleDestroy` |
| Gateway origin | `.../stt-ws.gateway.origin.task610.test.ts` | CSWSH deny-by-default incl. empty registry |
| Provider unit | `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` | init/lifecycle, `processAudio`, backpressure-drop visibility (L240) |
| Transport wiring | `packages/stt/src/__tests__/STTProcessor.streamingTransport.test.ts`, `STTProcessor.drainTimeout.task597.test.ts` | provider selection, drop-callback propagation, drain option threading |
| Python stream hygiene | `apps/stt/tests/unit/streaming/test_stream_hygiene.py` | `on_batch` wiring, `last_stream_id` persistence, `XTRIM MINID` + throttle, redis-error swallowing, recovery resume-from-stored-id, blocking-read timeout tolerance |
| Python finalize order | `.../test_session_manager_finalize_ordering.py`, `test_session_manager_tail_flush_guard.py` | `closed` published before durability work; tail flush at most once |
| E2E ticket auth | `apps/api/tests/e2e/streaming-ticket-refresh.spec.ts` | mid-session re-mint, one-shot enforcement, unbound-session 404 |
| E2E tenancy | `.../stt-session-cross-tenant.spec.ts`, `stream-ticket-scopes.spec.ts` | binding fail-closed, cross-tenant 404 no-leak, scope isolation |
| Harnesses | `apps/stt/tests/integration/test_streaming_{latency,loss,quality_scorecard}_harness.py` | wire-level replay through the real gateway + Redis |
| Helper library | `tests/helpers/streaming.helper.ts` (539 lines) | `loginStreamUser`, `createStreamSession`, `openStreamSocket`, `StreamSocket`, `feedFramesRealtime`, `loadPcm16`, `refreshStreamTicket`, `probeStreamHandshake`, committed 107 s PCM16 fixture (`:74-75`) |

**Weak or absent:**

- **No test anywhere uses a real Redis for streaming.** `stt-ws.gateway.test.ts` mocks it
  (`mockBridgeService.writeAudioFrame.mockRejectedValue(...)` L665). There is no
  `**/integration/**` TS suite touching streaming at all.
- **`streaming-resume-after-drop.spec.ts` is stale.** Its header documents the pre-grace-window
  gateway ("`handleDisconnect` DELETES that SessionInfo … calls `removeSession`") — behaviour that
  `sessionsById` + the 15 s grace timer replaced. Its `test.fixme` target contract may now pass
  *same-pod*. It must be re-baselined, not extended.
- **`streaming-backpressure-recovery.spec.ts`** explicitly concedes the egress watermark path is not
  reproducible on the live stack (`test.fixme` L135-141).
- No test exercises: cross-pod resume, pod restart, Redis restart, STT worker death mid-session,
  token expiry mid-session, tenant switch mid-session, two concurrent sessions per user, a
  long-duration session, `XAUTOCLAIM` reclaim, or control-stream loss.

---

## 3. Best-Practice Review (2025–2026)

Assessed against current vendor and standards practice. Sources listed inline.

### 3.1 Client-side buffering during disconnect — **we are below baseline**

Deepgram's own guidance is explicit: *"audio data will be produced but not transferred during the
reconnection period. To avoid losing produced audio while recovering the connection, your application
should store the audio data in a buffer"*
([Deepgram — Recovering From Connection Errors & Timeouts](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio)).
The recommended shape is a **bounded rolling buffer of unacknowledged audio replayed after
reconnect**, with exponential backoff (1/2/4/8/30 s).

G-03 is therefore not a HOPE-specific nicety — it is the industry's *first* stated obligation for a
streaming ASR client, and the deprecated provider already implemented it. **Recommendation:** a
bounded FIFO sized to the reconnect budget. With `maxAttempts: 5` and cap 30 s the worst-case outage
before terminal failure is ~60 s ⇒ ~750 frames at 80 ms ⇒ ~1.9 MB PCM. Bound at **60 s of audio,
drop-oldest, with an explicit `gap` event to the store** — never unbounded, never silent.

### 3.2 Session identity across reconnects — our design is *better* than most, and unused

Deepgram is unambiguous that a reconnect is a **new session**: *"you cannot truly 'resume' a session;
you must start a new streaming session after reconnection"* (ibid.). HOPE's `{type:'resume',
sessionId, lastSeq}` + server-assigned monotonic `seq` + bounded replay buffer is a *stronger*
contract than the vendor baseline. It is also inert the moment the reconnect lands on another pod
(G-01). The correct move is not to weaken the contract to vendor level — it is to move `SessionInfo`
into Redis, which the `captions` consumer-group design already anticipates
(`stt-ws.gateway.ts:96-102`). Appendix G2 fix (e) says the same thing.

**Corollary that must be designed for regardless:** every serious vendor caps stream duration, so a
long consultation *will* cross at least one reconnect. A 45-minute consultation is a normal case, not
an edge case.

### 3.3 Delivery semantics — correct where it counts

The result path is genuine at-least-once: PEL-first read, ack **after** emit
(`streamingAudioBridge.service.ts:454`, `:496-499`), `XAUTOCLAIM` for dead-consumer hand-off
(`:551-579`). Redis documents that consumer-group state — including the PEL — is propagated to AOF,
RDB and replicas, and that entries leave the PEL only on `XACK`
([Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/),
[XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/),
[XPENDING](https://redis.io/docs/latest/commands/xpending/)).
Dedup on the client is by monotonic `seq`, which is the right primitive.

The **audio** path is at-most-once by construction: MAXLEN-trimmed (D6) and fire-and-forget
(`stt-ws.gateway.ts:1014-1026`). That is a defensible trade — audio is a real-time signal and the
durable artefact is the transcript — but it must be *stated* and *bounded*, not discovered.

### 3.4 Redis as a durability substrate — **the configuration contradicts the role**

`allkeys-lru` will evict any key in the keyspace, including stream entries and consumer-group
metadata; guidance is consistent that `noeviction` is the correct policy for a keyspace that cannot
lose data, and `volatile-*` where cache and durable data are mixed
([Redis — Cache eviction strategies](https://redis.io/blog/cache-eviction-strategies/)). With
`--maxmemory 64mb`, a *single* consultation's audio stream at MAXLEN 10000 exceeds the budget
(§2.4 G-04), so eviction is not a tail risk — it is the steady state under two concurrent users.

This is Appendix G3's PHI conflict, now with a number attached. The decision is unchanged
(**(a)** AOF on an encrypted volume is the right answer) but the urgency is higher: `64mb` +
`allkeys-lru` means a Redis restart is not required to lose data — *ordinary concurrent use* is
sufficient.

### 3.5 Backpressure — sound, with a broken feedback edge

The two-tier policy (drop partials, queue finals bounded, emit a gap marker) is the right shape: it
degrades the disposable signal and protects the durable one. The failure is the feedback edge — the
client has no `gap` case (G-10). A drop the user cannot see is indistinguishable from correct
transcription, which in a clinical note is the worst possible failure mode.

### 3.6 Shutdown semantics — the close codes exist and are unused

RFC 6455 close codes are unambiguous: **1001 "going away"** signals a server going down and the
client should reconnect elsewhere; **1012 "service restart"** signals a restart with reconnection
expected ([WebSocket close codes reference](https://websocket.org/reference/close-codes/)). The
standard k8s pattern is: readiness gate closes → `preStop` sleep covers endpoint propagation →
iterate clients and `close(1001|1012, ...)` → allow in-flight work to settle → exit. Calling
`terminate()` or dropping the socket is a hard kill the client can only interpret as a network fault.

HOPE does none of this (G-02, G-07). Note the ordering dependency: **this fix is worthless until
TASK-616 §G9 #1 (probe paths) lands** — telling a client to reconnect while the pod is still in
Service endpoints just routes it back to the dying pod.

### 3.7 What belongs client-side vs server-side

| Concern | Correct owner | HOPE today |
|---|---|---|
| Audio buffering during outage | **Client** — only the client has the audio | Missing (G-03) |
| Session identity + replay buffer | **Server, externalized** | Server, in-process (G-01) |
| Ordering + dedup key | Server assigns, client dedups | ✅ correct |
| Auth for reconnect | Short-TTL single-use ticket | ✅ correct (30 s, one-shot) |
| Backpressure decision | Both, at each hop | ✅ correct shape, broken feedback (G-10) |
| Durable transcript | **Server** | ✅ correct |
| Recovery from terminal failure | **Client** (new session + gap marker) | Missing (G-05) |

---

## 4. Implementation Plan

Phased. Each task carries an **agent tier** from `haiku-4-5` / `sonnet-5` / `sonnet-5 \| opus-4-8` /
`opus-5 \| fable-5`. Tier reflects the reasoning load, not the line count.

### Phase 0 — Baseline & harness (no production code)

| # | Task | Tier | Verify |
|---|---|---|---|
| 0.1 | Re-baseline `streaming-resume-after-drop.spec.ts` against the current grace-window gateway; record what *actually* happens same-pod today; convert the stale header into an accurate one | `sonnet-5` | Spec runs against the live stack; recorded JSON attached; no green-washing |
| 0.2 | Extend `tests/helpers/streaming.helper.ts` with `restartService()`, `partitionSocket()`, `redisFlush()`, `waitForCaptions()`, `assertNoSeqGap()` | `sonnet-5` | Helpers used by ≥ 2 specs each |
| 0.3 | Add a TS integration tier for streaming (`packages/applications/src/services/stt/streaming/integration/`) wired to the real test Redis on 6380 | `sonnet-5` | `pnpm test:integration` picks it up; refuses to run outside a test DB |
| 0.4 | Add a Playwright project driving a **real browser mic** via `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop` | `sonnet-5 \| opus-4-8` | A headless Chromium run produces real captions from the committed fixture |

> **0.4 note.** The fake-audio flag requires a specific WAV format and supports a `%noloop` suffix to
> play once per run ([Playwright fake audio/video input](https://maddevs.io/writeups/testing-web-apps-with-speech-and-image-recognition/),
> [WebRTC testing flags](https://webrtc.github.io/webrtc-org/testing/)). Converting the existing
> 107 s fixture (`streaming.helper.ts:74-75`) is part of the task. This is the only way to test the
> *client-side* audio buffer (G-03) end-to-end — a Node `ws` client cannot exercise
> `AudioWorklet` → `processAudio`.

### Phase 1 — P0 correctness (TDD; each starts with a failing test)

| # | Task | Tier | Files |
|---|---|---|---|
| 1.1 | **Client audio buffer during disconnect** — bounded FIFO (60 s, drop-oldest), replay on reconnect, `gap` event on overflow | `sonnet-5 \| opus-4-8` | `packages/stt/src/providers/StreamingBackendSTTProvider.ts:292-296` |
| 1.2 | **Recover from `unknown_session`** — tear down, create a replacement session, emit a visible gap marker, resume capture | `opus-5 \| fable-5` | `SttWebSocketClient.ts:1143-1145`, `PluginManager.ts:811-814`, `useArcaAudio.ts:649-651` |
| 1.3 | **Handle `{type:'gap'}` in the SDK** → store + UI | `haiku-4-5` | `SttWebSocketClient.ts:1072-1187` |
| 1.4 | **Gate `handleConnection` on `isShuttingDown`**; on shutdown send `{type:'server_draining'}`, close **1012**, honour ~2 s before finalizing | `sonnet-5 \| opus-4-8` | `stt-ws.gateway.ts:236-261`, `:379` |
| 1.5 | **Retry 5xx** on `createSession` / `refreshTicket` (3 attempts, jittered) | `sonnet-5` | `StreamingSessionManager.ts:93-147`, `:204-226` |
| 1.6 | **Redis config decision + change** — `noeviction`, raise `maxmemory` to a computed bound (sessions × 25 MB + headroom), AOF-on-encrypted-volume per Appendix G3(a) | `opus-5 \| fable-5` | `infrastructure/docker/docker-compose.yml:180-186`; **owner decision required** |

### Phase 2 — P0 structural: externalize `SessionInfo`

| # | Task | Tier |
|---|---|---|
| 2.1 | Design the Redis representation of `SessionInfo` — resume buffer (bounded, PHI-bearing → TTL + encryption posture), `resultSeq`, `sampleRate`, tenant, `freshlyCreated` semantics across pods | `opus-5 \| fable-5` |
| 2.2 | Implement; keep the in-process `Map` as a write-through cache; `rebindSession` becomes "load-or-rebind" | `opus-5 \| fable-5` |
| 2.3 | Cross-pod resume E2E (two gateway instances, reconnect forced onto the second) | `sonnet-5 \| opus-4-8` |

> **Sequencing.** 2.x depends on 1.6. Putting a PHI-bearing resume buffer into a Redis configured with
> `allkeys-lru` and no persistence makes the durability story *worse*, not better.

### Phase 3 — P1 service-side

| # | Task | Tier |
|---|---|---|
| 3.1 | STT `stop()` finalizes active sessions within a bounded budget (tail flush + `closed` + durable transcript); leave blob upload to recovery | `opus-5 \| fable-5` |
| 3.2 | Control stream → consumer group + `XACK` + `XAUTOCLAIM`, matching the ingest path | `sonnet-5 \| opus-4-8` |
| 3.3 | Reconcile STT's module-level SIGTERM handler with the uvicorn lifespan (Appendix G10 Q7) | `sonnet-5 \| opus-4-8` |
| 3.4 | Promote D7/D8/D11/D12 to counters + a `degraded` status frame to the client | `sonnet-5` |

### Phase 4 — Test build-out

Implement §5 in the order **unit → integration → E2E → chaos**. Tiers: unit `sonnet-5`; integration
`sonnet-5 \| opus-4-8`; production-scenario E2E `opus-5 \| fable-5` (they encode the clinical
contract and are the ones most likely to be written to pass rather than to prove).

### Phase 5 — Gate

| # | Task | Tier |
|---|---|---|
| 5.1 | New CI job `test-streaming-resilience` (Redis + gateway + stubbed STT), **blocking** | `sonnet-5 \| opus-4-8` |
| 5.2 | Promote `test-sdk` from `allow_failure` to blocking for `@arcaai/vox` + `@arcaai/stt` | `haiku-4-5` |
| 5.3 | Nightly `test-streaming-live` (full stack, real ASR) — advisory, but a red nightly blocks promotion | `sonnet-5` |
| 5.4 | Update `docs/operations/testing/ci-gates.md` + `test-strategy.md` §8 | `haiku-4-5` |

---

## 5. Test Matrix — the centrepiece

Legend: **Gate** = must be green to promote. **CI** = runs automatically. **Nightly** = scheduled.
**Local** = documented manual procedure with recorded evidence.

### 5.1 Unit — Vitest (TS)

| ID | Target | Assertion | Gate | New? |
|---|---|---|---|---|
| U-01 | Audio buffer bound | 60 s cap; oldest dropped first; `gap` emitted exactly once per overflow episode | ✅ | new (1.1) |
| U-02 | Buffer replay order | On reconnect, buffered frames flush **before** any new frame; strict FIFO | ✅ | new |
| U-03 | Buffer is not used when never connected | `init()` failure must not silently accumulate an unbounded buffer | ✅ | new |
| U-04 | Resume state machine | Table-driven over `{freshlyCreated, lastSeq, resultSeq, bufferMin}` → `resumed \| resume_failed(unknown_session) \| resume_failed(buffer_overflow)` — every cell | ✅ | extends `stt-ws.gateway.test.ts` L1039/L1104 |
| U-05 | `unknown_session` recovery | Client creates a replacement session, emits a gap, resumes capture — **does not** go terminal | ✅ | new (1.2) |
| U-06 | `buffer_overflow` stays recoverable | No new session; live stream continues | ✅ | exists (partial) |
| U-07 | Backoff | 5 attempts, exponential, jitter ∈ [0, 0.5×], cap 30 s; budget resets only after a server message | ✅ | exists `SttWebSocketClient.test.ts` |
| U-08 | Ticket refresh abort | `refreshTicket` throw ⇒ `onReconnectFailed`, no socket opened | ✅ | exists |
| U-09 | 5xx retry | `createSession`/`refreshTicket` retry 3× on 502/503/504; **do not** retry 4xx | ✅ | new (1.5) |
| U-10 | `gap` handling | SDK routes `{type:'gap'}` to the store; no "unknown message type" warning | ✅ | new (1.3) |
| U-11 | Shutdown gate | `handleConnection` during `isShuttingDown` closes 1012 without registering a session | ✅ | new (1.4) |
| U-12 | Shutdown drain | `onModuleDestroy` sends `server_draining`, closes 1012, and **does not** cancel grace timers before the drain window | ✅ | replaces `stt-ws.gateway.test.ts` `onModuleDestroy` case |
| U-13 | Egress backpressure | Partials dropped pre-seq-tag; finals queued ≤ 200; overflow drops oldest + emits `gap` with `droppedSeq` | ✅ | exists L1271 |
| U-14 | Seq monotonicity | `seq` strictly increasing across rebind; a dropped partial never consumes a seq | ✅ | extend |
| U-15 | Consumer-group cursor | Bridge reads PEL (`'0'`) before live (`'>'`); acks only after emit; `finalizing` never terminal | ✅ | extend `streamingAudioBridge.service.test.ts` |

### 5.2 Unit — pytest (Python)

| ID | Target | Assertion | Gate | New? |
|---|---|---|---|---|
| P-01 | Ingest reclaim | `XAUTOCLAIM` honours min-idle 30 s and the 15 s throttle; first pass uses idle 0 | ✅ | extends `test_stream_hygiene.py` |
| P-02 | Recovery claim | Session with an expired `stt:worker:{id}` is claimed; one with a live key is **not** | ✅ | new |
| P-03 | Control group | After Phase 3.2: a control command published while the listener is down is delivered on restart | ✅ | new (3.2) |
| P-04 | Finalize on stop | `SessionManager.stop()` publishes `finalizing` → tail final → `closed` for every active session within budget | ✅ | new (3.1) |
| P-05 | Finalize ordering | `closed` precedes durability work | ✅ | exists `test_session_manager_finalize_ordering.py` |
| P-06 | Queue-full is loud | Inference-queue drop increments the counter **and** publishes a `degraded` status | ✅ | new (3.4) |
| P-07 | Decode failure is loud | Malformed frame increments a counter, still acks | ✅ | new (3.4) |

### 5.3 Integration — real Redis (test infra, port 6380)

Runner: Vitest `**/integration/**` (TS) + pytest (Python). Requires `pnpm infra:test:up`.

| ID | Scenario | Setup → Action → Expected | Gate |
|---|---|---|---|
| I-01 | Round trip | Bridge writes 100 frames → a Python-shaped consumer reads via `stt-ingest` → publishes 5 results → bridge relays all 5 in order, no duplicates | ✅ |
| I-02 | Consumer death mid-batch | Read 50 entries without acking → kill the reader → start a new consumer, same group → **all 50 redelivered exactly once** via PEL + `XAUTOCLAIM` | ✅ |
| I-03 | `XAUTOCLAIM` reclaim | Consumer A leaves 10 pending, idles > 30 s → B reclaims and acks all 10; `XPENDING` = 0 | ✅ |
| I-04 | Cursor survives resubscribe | `captions` group reads to entry 40 → unsubscribe → resubscribe → reads from 41, **never** `0-0` | ✅ |
| I-05 | Fan-out preserved | `captions` + a unique-group subscriber both receive **every** result | ✅ |
| I-06 | Writer offline queue | `DEBUG SLEEP` / pause Redis 3 s while writing → on recovery all frames present **in original order** | ✅ |
| I-07 | MAXLEN eviction is detectable | Write 12 000 frames without consuming → assert the oldest 2 000 are gone **and** a detectable signal exists (post-fix: a counter, not a log) | ✅ |
| I-08 | `noeviction` holds (post-1.6) | Fill to `maxmemory` → writes fail loudly with OOM; **no key is silently evicted** | ✅ |
| I-09 | Redis restart | Restart the container mid-stream → assert the **documented** outcome (post-AOF: streams + groups survive; pre-AOF: total loss, and the client sees a hard error, never silence) | ✅ |
| I-10 | Session state cross-pod (post-2.2) | Gateway A registers a session → A's `Map` cleared → gateway B loads it from Redis and answers `resumed fromSeq: lastSeq+1` | ✅ |

### 5.4 E2E / production scenarios — Playwright (`apps/api/tests/e2e/`)

**These are the ones that matter.** Each specifies setup, action, observable expectation and the
assertion. Fixture: the committed 107 s PCM16 clip (`tests/helpers/streaming.helper.ts:74-75`); the
browser-driven ones use the Phase-0.4 fake-audio project.

| ID | Scenario | Setup | Action | Expected observable | Assertion | Gate |
|---|---|---|---|---|---|---|
| **E-01** | **Pod restart mid-consultation** | 2 gateway instances behind one port; session on A; feed 20 s | `SIGTERM` A at t=20 s; keep feeding for 40 s | Client receives `server_draining` + close **1012**, reconnects to B within backoff, resumes from `lastSeq+1` | `finalTranscripts` contains **zero** seq gaps across the restart; buffered audio replayed; total spoken words ≥ 95 % of the same run without a restart | ✅ |
| **E-02** | **Network partition mid-utterance** | Session live, feed 15 s | `socket.terminate()` (no close frame) mid-utterance; hold 8 s; resume | Client buffers, backs off, re-mints a ticket, resumes | No final lost; the interrupted utterance appears exactly once (not split, not duplicated) | ✅ |
| **E-03** | **Partition longer than the grace window** | as E-02 | Hold **25 s** (> `WS_RESUME_GRACE_MS` 15 s) | `resume_failed: unknown_session` → **new session created**, gap marker surfaced | Captions resume; store shows a visible gap; state never lands on terminal `error` | ✅ |
| **E-04** | **Redis restart mid-consultation** | Session live, 20 s fed | Restart Redis | Post-AOF: session survives or fails loudly | Either captions resume, **or** the client shows an explicit terminal error — a frozen-but-connected UI **fails this test** | ✅ |
| **E-05** | **STT worker death (OOM proxy)** | Session live, 20 s fed | `SIGKILL` the STT process; restart | Recovery scan claims the session; audio from the buffered stream is consumed | Post-restart transcripts continue; audio produced during the gap is transcribed (bounded by MAXLEN), not silently skipped | ✅ |
| **E-06** | **GPU crash-loop / STT never returns** | Session live; STT restarts into a failing model load | Feed 30 s | Client is told the session is degraded within ≤ 10 s | A `degraded`/`error` status reaches the store; the UI does **not** show a healthy-but-silent stream | ✅ |
| **E-07** | **Stream-ticket expiry mid-session** | Session live | Idle > 30 s, then force a reconnect | `refreshTicket` mints a new ticket; reconnect succeeds | Reconnect succeeds; the stale ticket is rejected 4401 | ✅ (exists, extend `streaming-ticket-refresh.spec.ts`) |
| **E-08** | **JWT expiry mid-session** | Short-lived access token | Let it expire, then force a reconnect | Token refresh runs before ticket mint | Reconnect succeeds. **Today this fails** (G-13) | ✅ |
| **E-09** | **Tenant switch mid-session** | Session live under tenant A | Switch working tenant to B | The A session is torn down cleanly; no B caption ever carries A data | Cross-tenant assertion: 404 on A's session from B; no transcript crossover | ✅ |
| **E-10** | **Two concurrent sessions, one user** | Same user, two tabs, two sessions | Feed distinct audio to each | Independent seq spaces, independent resume buffers | No caption crossover; per-tenant socket counts correct (`getPerTenantSessionCounts`) | ✅ |
| **E-11** | **45-minute consultation** | One session, 45 min of looped fixture | Run to completion | Session survives; memory stable | Zero unexplained seq gaps; gateway RSS growth < agreed bound; resume buffer stays bounded at 200; ≥ 1 reconnect exercised deliberately | Nightly |
| **E-12** | **Slow-consumer backpressure** | Session live; client stops reading (stall the socket) | Feed 60 s non-realtime | Partials dropped, finals queued then delivered, `gap` on overflow | Every **final** either arrives or produces a client-visible `gap`; **no final is both dropped and unreported** | ✅ |
| **E-13** | **Rolling update, no restart of the client** | 2 instances, `maxUnavailable: 0` | Roll the image | Sessions migrate | Same assertions as E-01, repeated across 3 consecutive rolls | Nightly |
| **E-14** | **Capacity exhaustion** | Fill to `max_streams` | Open one more | HTTP 503 + `Retry-After: 5` | Existing sessions unaffected; the rejected client shows an actionable message | ✅ |
| **E-15** | **Browser-driven full path** | Playwright + fake audio device | Start → speak 60 s → stop | Real capture → real captions | Captions appear; `stopAndDrain` delivers the tail final; store `droppedFrames` = 0 | ✅ |
| **E-16** | **Browser-driven with a forced outage** | as E-15 | Kill the gateway at t=20 s | Client-side buffer replays | Word-level recall across the outage ≥ 95 % vs the clean run. **This is the direct test of G-03** | ✅ |

### 5.5 Chaos / resilience — what is honestly automatable

| Scenario | CI-automatable? | How | Honest limitation |
|---|---|---|---|
| Process kill (gateway, STT) | **Yes** | `docker compose kill` / `restart` from the spec | Docker-level, not kubelet-level: no `preStop`, no endpoint propagation, no `terminationGracePeriodSeconds`. **E-01 in CI proves the application contract, not the k8s contract.** |
| Redis restart | **Yes** | `docker compose restart redis` | Same caveat; also cannot reproduce a real memory-pressure eviction cascade |
| Network partition | **Partly** | `socket.terminate()` covers client-observed loss cleanly | A real partition (packet loss, one-way blackhole, TCP half-open) needs a proxy layer. Recommend **toxiproxy** in front of the test Redis + gateway — this is the single highest-value chaos addition and is CI-viable |
| Latency / jitter injection | **Yes, with toxiproxy** | Latency + bandwidth toxics | Realistic mobile/clinic networks still differ |
| Redis OOM eviction cascade | **Partly** | Set `maxmemory 8mb` in a dedicated compose profile and drive it | Deliberately unrealistic sizing; proves the *mechanism*, not the *threshold* |
| GPU crash-loop | **No** | — | No GPU in CI, and per Appendix G4 it is not established that STT uses the GPU at all. **Simulate** by starting STT with a bad model path (E-06). A real GPU fault is a documented local procedure |
| k8s rolling update, probe/drain behaviour | **No** | — | Needs a real cluster. **Nightly against the dev cluster, or manual with recorded evidence.** This is where the TASK-616 §G9 #1/#2/#6 fixes are actually verified |
| Node failure | **No** | — | Single-node k3s. Appendix G8 already states this cannot be delivered. Do not pretend otherwise |
| Multi-hour soak | **No (CI)** | — | Nightly only (E-11) |
| Real clinical audio at scale | **No** | — | PHI. The regression fixture is the committed synthetic/consented clip; §10 of `test-strategy.md` forbids PHI in tests and that stands |

**Explicit statement for the record:** items marked "No" above are **not covered by the automated
gate**. Promoting the pipeline into automated CI/CD does not mean these risks are eliminated — it
means they are named, and their verification is a scheduled human activity with recorded evidence.
Any claim that the STT pipeline is "fully tested" that does not carry this paragraph is false.

---

## 6. Gate Definition — entry into automated CI/CD promotion

The STT pipeline may enter the automated promotion flow when **all** of the following hold.

### 6.1 Blocking CI jobs (every pipeline)

| Job | Contents |
|---|---|
| `test-api` | existing, **plus** the full §5.1 gateway unit set (U-04, U-11 … U-15) |
| `test-sdk` | **promoted from `allow_failure` to blocking** for `@arcaai/vox` + `@arcaai/stt` — U-01 … U-10 |
| `test-stt` (unit) | **promoted to blocking** for the streaming subset — P-01 … P-07 |
| `test-streaming-resilience` | **new.** Real Redis + gateway + stubbed STT worker. All of §5.3 I-01 … I-10 |
| `test-streaming-e2e` | **new, blocking.** All §5.4 rows marked Gate ✅, against a compose-booted stack |

### 6.2 Nightly (red nightly blocks the next promotion)

- E-11 (45-minute soak), E-13 (three consecutive rolling updates)
- `test-streaming-live` — full stack with real ASR, including the quality scorecard
  (`apps/stt/tests/integration/test_streaming_quality_scorecard.py`) so a resilience fix cannot
  silently regress transcription quality

### 6.3 Non-negotiable preconditions

| # | Precondition |
|---|---|
| GATE-1 | Every **P0** gap in §2.4 is closed. No waivers at P0. |
| GATE-2 | Every **P1** gap is closed **or** carries an owner-signed waiver naming the accepted clinical risk, recorded in this README's Change History. |
| GATE-3 | The Redis durability decision (§3.4 / Appendix G3) is made, applied, and covered by I-08/I-09. **A promotion flow that automatically deploys onto `allkeys-lru` + `64mb` + no persistence is not defensible.** |
| GATE-4 | TASK-616 §G9 items #1 (probe paths), #2 (OTel `process.exit`), #6 (`preStop` + tGPS) are merged — E-01/E-13 verify the *application* half; without the platform half they measure nothing. |
| GATE-5 | Every silent-drop site in §2.3 is either eliminated or emits a counter **and** a client-visible signal. |
| GATE-6 | §5.5's "not automatable" list is published in `ci-gates.md` alongside the gate, so no reader mistakes a green pipeline for full coverage. |

---

## 7. Verification Criteria

- [ ] `pnpm lint:all` · `pnpm typecheck:all` green (evidence pasted)
- [ ] `pnpm test:unit` green, including all new §5.1/§5.2 tests — **each observed RED first**
- [ ] `pnpm test:integration` green with real Redis (§5.3)
- [ ] `pnpm test:e2e` green for the new streaming specs against a booted stack (§5.4)
- [ ] `pnpm py:stt:test` green (§5.2)
- [ ] E-01 and E-16 demonstrated **failing before** the Phase-1 fixes and **passing after** — the two
      that prove the headline clinical defect
- [ ] A 45-minute soak run recorded with memory + seq-gap evidence
- [ ] One manual k8s rolling-update run recorded (screenshots/logs) — the part CI cannot do
- [ ] `docs/operations/testing/ci-gates.md` and `test-strategy.md` §8 updated
- [ ] Change History below updated with the gap-by-gap disposition (fixed / waived + why)

---

## 8. Open Questions

| # | Question | Why it blocks | Owner |
|---|---|---|---|
| Q1 | **Redis durability: AOF-on-encrypted-volume, or accept total in-flight loss?** Appendix G3 recommends (a). §3.4 shows the current `64mb` + `allkeys-lru` loses data during *ordinary concurrent use*, not just on restart. | GATE-3; blocks Phase 2 | Owner + clinical/compliance |
| Q2 | **What is the acceptable clinical loss budget?** "≥ 95 % word recall across an outage" in E-01/E-16 is my proposal, not a ratified number. A clinical documentation product may require 100 % of *finalized* utterances and tolerate partial loss only. | Defines the E-01/E-16 assertions | Owner + clinical |
| Q3 | **Should a resume buffer holding transcript text live in Redis at all?** It is PHI. Phase 2 externalizes it; that may require encryption-at-rest or a design that stores only `seq` + a pointer to the durable transcript. | Blocks Phase 2 design | Owner + compliance |
| Q4 | **Max supported consultation duration and concurrent sessions per tenant?** Sizes the Redis budget, the HPA signal (Appendix G7), and E-11. | Blocks 1.6 sizing | Owner |
| Q5 | **Is `sessionsById` intended to become the only session store, or should the pipeline move to sticky sessions?** Sticky routing is cheaper but fails on pod death — the exact case this ticket exists for. Recommend externalization. | Phase 2 approach | Platform |
| Q6 | **Does uvicorn's SIGTERM handling or STT's module-level handler win?** (`apps/stt/src/stt/main.py:267-273`) — Appendix G10 Q7, still unanswered. If the module handler wins, `shutdown_streaming()` never runs and Phase 3.1 is unreachable. | Blocks 3.1/3.3 | Platform |
| Q7 | **Is `test-sdk` allowed to become blocking?** It currently covers vox, room, vad, stt, noise-filter, med-ner, ui. Promoting the whole job may block on unrelated flakiness; splitting it is extra work. | 5.2 | Platform |
| Q8 | **Do we adopt toxiproxy?** It is the single highest-value chaos addition and the only CI-viable path to real partition testing, at the cost of one more test-infra container. | 5.5 | Platform |

---

## 9. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-07 | Ticket created. End-to-end trace with citations, 9-item state inventory, 12-item silent-drop inventory, 17-item gap table, best-practice review with sources, 5-phase plan, test matrix (15 TS unit / 7 pytest / 10 integration / 16 E2E / chaos honesty table), gate definition. Status: Pending — awaiting owner decisions Q1–Q8. | Claude (Opus 5) |
| 2026-08-12 | Closed — scope substantially covered by TASK-505 (STT Pipeline Restructure), TASK-594 (ml-en Code-Switch Quality), and TASK-614 (STT Provider Switching & Fallback); remaining gap not being pursued separately. | Claude |

---

## Appendix A — Sources

| Topic | Source |
|---|---|
| Client audio buffering during reconnect; reconnect is a new session | [Deepgram — Recovering From Connection Errors & Timeouts When Live Streaming](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio) |
| Keep-alive / idle-timeout behaviour on streaming ASR sockets | [Deepgram — Audio Keep Alive](https://developers.deepgram.com/docs/audio-keep-alive) |
| Consumer groups, PEL, ack semantics, replication of group state | [Redis — Streams](https://redis.io/docs/latest/develop/data-types/streams/) · [XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/) · [XPENDING](https://redis.io/docs/latest/commands/xpending/) |
| Eviction policy choice; `noeviction` for data that cannot be lost | [Redis — Cache eviction strategies](https://redis.io/blog/cache-eviction-strategies/) |
| WebSocket close codes 1001 / 1012 semantics (RFC 6455 + IANA registry) | [WebSocket close codes reference](https://websocket.org/reference/close-codes/) |
| Fake microphone input for browser tests (`--use-file-for-fake-audio-capture`, `%noloop`, format) | [Playwright fake audio & video input](https://maddevs.io/writeups/testing-web-apps-with-speech-and-image-recognition/) · [WebRTC testing flags](https://webrtc.github.io/webrtc-org/testing/) |
| Internal — deployment/HA context | [`TASK-616 Appendix G`](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) |
| Internal — test governance | [`docs/operations/testing/test-strategy.md`](../../operations/testing/test-strategy.md) · [`ci-gates.md`](../../operations/testing/ci-gates.md) · [`tests/README.md`](../../../tests/README.md) |
