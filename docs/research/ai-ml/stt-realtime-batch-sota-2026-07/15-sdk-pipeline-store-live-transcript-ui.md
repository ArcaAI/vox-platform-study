> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `aac0cdb85b32a34ad` (sub-agent of 11). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Realtime STT Pipeline & Live Transcript UI — Research Findings

All paths absolute from repo root `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/`. Worktree copies under `.claude/worktrees/` were not read.

---

### 1. `audio.start({pipelineId, language, deviceId, secondaryDeviceId})` trace — `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`

**`AudioStartOptions` exact shape** (`packages/agentic-sdk-v2/src/types/audio.ts:269-297`):
```ts
export interface AudioStartOptions {
  language?: string;
  pipelineId?: string;
  deviceId?: string;
  secondaryDeviceId?: string;
  dualCaptureEnabled?: boolean;
  onDualCapture?: (result: DualCaptureResult) => void;
}
```

**`pipelineId` does NOT branch local-vs-backend inside `useArcaAudio.ts` itself.** It is only forwarded:
```ts
// useArcaAudio.ts:77-84
pluginManager.setRuntimeOptions?.({
  pipelineId: options?.pipelineId,
  consultationId: consultation?.id,
  language: options?.language,
});
```
The actual branch lives in `PluginManager.getTranscriptionPipelineConfig()` (`packages/agentic-sdk-v2/src/core/PluginManager.ts:539-614`):
```ts
// PluginManager.ts:544-548
const effectivePipelineId = this.runtimeOptions.pipelineId ?? sttConfig.pipelineId;
const streamingTransport = this.buildStreamingTransport(sttConfig, effectivePipelineId);
...
// PluginManager.ts:596
location: sttConfig.provider === 'local' ? 'browser' : sttConfig.provider === 'backend' ? 'backend' : 'auto',
```
and `buildStreamingTransport` (`PluginManager.ts:743-773`):
```ts
buildStreamingTransport(sttConfig: STTPluginConfig, pipelineId: string | undefined): unknown {
  if (!pipelineId) return undefined;
  if (!this.apiClient) { ... return undefined; }
  const provider = sttConfig.provider ?? DEFAULT_STT_CONFIG.provider;
  if (provider === 'local') { return undefined; }
  const sessionManager = new StreamingSessionManager(this.apiClient, this.logger);
  const wsClient = new SttWebSocketClient(this.logger, { enabled: true, refreshTicket: async () => sessionManager.refreshTicket() }, this._debugMode);
  return { sessionManager, wsClient, pipelineId, consultationId: this.runtimeOptions.consultationId };
}
```
The final local-vs-remote decision is made in `TranscriptionPipeline.resolveSTTRuntimeProvider()` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:584-619`), which prioritizes a server-resolved `transcriptionMode` (`'LOCAL'`/`'BACKEND'`), then `provider`, then `location`, and finally defaults to `'remote'` **whenever `sttSocket` or `streamingTransport` exists** (`TranscriptionPipeline.ts:618`: `return this.config.stt.sttSocket || this.config.stt.streamingTransport ? 'remote' : 'local';`).

**`deviceId`/`secondaryDeviceId` — yes, they feed `@arcaai/room`'s `AudioMixer`** (`useArcaAudio.ts:14` imports `{ AudioContextManager, AudioMixer } from '@arcaai/room'`):
```ts
// useArcaAudio.ts:98-101
const stream = await navigator.mediaDevices.getUserMedia({
  audio: options?.deviceId ? { deviceId: { exact: options.deviceId } } : true,
});
...
// useArcaAudio.ts:112-132
let track = stream.getAudioTracks()[0];
if (options?.secondaryDeviceId) {
  const secondaryStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: options.secondaryDeviceId } },
  });
  secondaryStreamRef.current = secondaryStream;
  const mixer = new AudioMixer(audioContext);
  mixer.addSource('primary', stream);
  mixer.addSource('secondary', secondaryStream);
  mixerRef.current = mixer;
  const mixedTrack = mixer.getMixedTrack();
  if (mixedTrack) track = mixedTrack;
  ...
}
```
The mixed (or single) `track` is then handed to `pluginManager.initialize(track, audioContext)` (`useArcaAudio.ts:240`) which feeds the NoiseFilter→VAD→STT chain. Teardown: `mixerRef.current.dispose()` on stop (`useArcaAudio.ts:364-367`).

---

### 2. Audio pipeline order — hardcoded priorities, not the KnowledgePipeline's `location`/`triggerMode` model

The Mic→AudioTrack→NoiseFilter→VAD→STT order is **hardcoded via numeric `priority` fields** in `TranscriptionPipeline.setupStageFactories()` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:119-217`):
```ts
this.stages.set('noiseFilter', { name: 'noiseFilter', enabled: ..., priority: 10, ... });   // line 121-134
this.stages.set('vad',         { name: 'vad',         enabled: ..., priority: 20, ... });   // line 137-153
this.stages.set('stt',         { name: 'stt',         enabled: ..., priority: 30, ... });   // line 156-216
```
and executed via `getEnabledStages()` (`TranscriptionPipeline.ts:639-643`):
```ts
private getEnabledStages(): ProcessorStage[] {
  return Array.from(this.stages.values())
    .filter((stage) => stage.enabled)
    .sort((a, b) => a.priority - b.priority);
}
```
In `start()` (`TranscriptionPipeline.ts:222-335`), each enabled stage's `processedTrack` becomes `currentTrack` for the next stage (line 269-271) — a literal chained MediaStreamTrack pipeline.

**`TranscriptionPipelineConfig` DOES carry a per-stage `location` field**, but it is materially different from `KnowledgePipeline`'s: only `stt.location`/`stt.provider` actually branches execution (local Whisper vs. `StreamingBackendSTTProvider`); `noiseFilter.location` (`'browser'|'skip'`) and `vad.location` (`'browser'` only) exist in the type but there is no backend noise-filter/VAD implementation to branch to — only `enabled` + `priority` matter for those two. Exact type (`packages/agentic-sdk-v2/src/types/pipeline.ts:64-156`):
```ts
export interface TranscriptionPipelineConfig {
  debugMode?: boolean;
  contextOwnership?: 'owned' | 'borrowed';
  noiseFilter: { enabled: boolean; location: 'browser' | 'skip'; level?: 'low' | 'medium' | 'high' };
  vad: { enabled: boolean; location: 'browser'; sensitivity?: number; minSpeechDuration?: number; minSilenceDuration?: number };
  stt: {
    enabled: boolean;
    location: 'browser' | 'backend' | 'auto' | 'skip';
    provider?: 'local' | 'backend' | 'auto';
    transcriptionMode?: 'LOCAL' | 'BACKEND';
    language?: string; modelId?: string; sttSocket?: string; pipelineId?: string;
    diarization?: boolean; numSpeakers?: number; returnTimestamps?: boolean | 'word'; codeSwitching?: boolean;
    streamingTransport?: unknown;
    voiceProfile?: { id?: string; reservedSpeakerId?: string; similarityThreshold?: number };
    task?: 'transcribe' | 'translate';
  };
}
```
Default order/config example (`DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG`, `types/pipeline.ts:161-185`):
```ts
export const DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG: TranscriptionPipelineConfig = {
  contextOwnership: 'borrowed',
  noiseFilter: { enabled: true, location: 'browser', level: 'high' },
  vad: { enabled: true, location: 'browser', sensitivity: 0.5, minSpeechDuration: 250, minSilenceDuration: 300 },
  stt: { enabled: true, location: 'auto', provider: 'auto', language: 'en-US', diarization: false, numSpeakers: 2, returnTimestamps: 'word', codeSwitching: false },
};
```

By contrast, `KnowledgePipeline` (NER/spellCheck/summarization — `packages/agentic-sdk-v2/src/core/KnowledgePipeline.ts`) genuinely branches on `location: 'browser'|'backend'|'auto'|'disabled'` and `triggerMode: 'auto'|'manual'` (`KnowledgeStage` interface, `KnowledgePipeline.ts:50-57`), and `executeNER`/`executeSpellCheck` **throw** when `location === 'backend'` because the gateway no longer proxies `/nlp/*` (TASK-216) (`KnowledgePipeline.ts:450-456`, `518-525`). `DEFAULT_KNOWLEDGE_PIPELINE_CONFIG` at `types/pipeline.ts:261-278`.

---

### 3. `SttWebSocketClient.ts` (`packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`)

The file's own header doc (lines 1-18) summarizes the protocol (this docblock is itself slightly stale — it omits the `resume`/`resumed`/`resume_failed` frames that exist in the actual code):
```
 * Client → Server:
 *   - Binary PCM frames (Int16 LE, mono)
 *   - JSON: { type: 'audio', seq, data (base64), microphoneId? }
 *   - JSON: { type: 'stop' }
 *   - JSON: { type: 'close' }
 *
 * Server → Client:
 *   - { type: 'transcript', text, startTime, endTime, isFinal, speakerId?, speakerConfidence?, wordTimestamps?, inference? }
 *   - { type: 'status', status, message }
 *   - { type: 'error', code, message }
```

**a. WS URL construction** — NOT built inside `SttWebSocketClient.ts`; built by `StreamingSessionManager.getWebSocketUrl()` (`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:148-183`):
```ts
const parsed = new URL(this.apiClient.getWsUrl() ?? this.apiClient.getBaseUrl());
const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
const wsOrigin = `${wsProtocol}//${parsed.host}`;
const wsPath = this.sessionResponse.wsUrl || STT_ENDPOINTS.WS_STREAM;   // '/ws/stt/stream'
const params = new URLSearchParams({ sessionId: this.sessionId });
if (this.sessionResponse.ticket) params.set('ticket', this.sessionResponse.ticket);
const tenantId = this.apiClient.getTenantId();
if (tenantId) params.set('tenantId', tenantId);
return `${wsOrigin}${wsPath}?${params.toString()}`;
```
Base origin source: `apiClient.getWsUrl() ?? apiClient.getBaseUrl()` (`packages/agentic-sdk-v2/src/core/AgenticClient.ts:990-1001`, TASK-431 — lets REST ride a same-origin BFF proxy while WS hits the gateway directly). `STT_ENDPOINTS.WS_STREAM = '/ws/stt/stream'` (`packages/agentic-sdk-v2/src/core/constants.ts:379`).

**b. Auth — yes, a stream ticket is fetched first, then attached as a query param (not a control frame).**
- `StreamingSessionManager.createSession()` (`StreamingSessionManager.ts:81-135`) does `POST STT_ENDPOINTS.CREATE_SESSION` = `'/audio/transcription-jobs/stream/session'` (`constants.ts:369`). Response `StreamingSessionResponse.ticket?: string` (`types/stt.ts:98-124`, comment lines 109-115: "One-shot stream ticket... The SDK appends `?ticket=<value>`... the ticket becomes invalid afterwards").
- The ticket is appended as `?ticket=` (see `getWebSocketUrl` above) — **not** sent as a first control frame. `StreamingSessionManager.getWebSocketUrl` doc (lines 141-146) explicitly states the JWT is never in the URL and suggests `ws.send(JSON.stringify({ type: 'auth', token }))` as the pattern, but **no such `'auth'` message is ever actually sent anywhere in `SttWebSocketClient.ts`** — real auth for the WS upgrade is entirely the one-shot `ticket` query param.
- On reconnect, a fresh ticket is minted via `STT_ENDPOINTS.REFRESH_TICKET(sessionId)` = `` `/audio/transcription-jobs/stream/session/${sessionId}/refresh-ticket` `` (`StreamingSessionManager.refreshTicket()`, lines 192-214), and `SttWebSocketClient.replaceTicketParam()` swaps `?ticket=` on `lastUrl` before reconnecting (lines 974-986).
- A fail-closed **tenant-claim guard** also runs before any socket opens: `connect()` rejects with `Error('WebSocket connect blocked: no tenant claim resolvable from connect context')` when `requireTenantClaim` (default `true`, line 223) can't resolve a claim from `options.tenantClaim` or the URL's `tenantId`/`tenant` param (`resolveTenantClaim`, lines 616-630).

**c. Outgoing audio frame protocol — raw binary Int16LE, not JSON/base64, in actual runtime use.** Two send methods exist:
```ts
// line 355-363 — used at runtime
sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean {
  this.requireConnection();
  if (this.shouldDropForBufferedAmount()) { this.dropFrameDueToBackpressure('buffered_amount_high'); return false; }
  this.ws!.send(data);
  return true;
}
// line 370-382 — JSON alternative, NOT called anywhere in the actual capture path
sendAudioFrameJson(seq: number, data: string, microphoneId?: string): boolean {
  ...
  const frame: WsAudioFrame = { type: 'audio', seq, data };
  if (microphoneId) frame.microphoneId = microphoneId;
  this.ws!.send(JSON.stringify(frame));
  return true;
}
```
`ws.binaryType = 'arraybuffer'` is set at connect (`SttWebSocketClient.ts:247`). The real caller is `StreamingBackendSTTProvider.processAudio()` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:225-243`):
```ts
async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
  if (!this.processing || !this.wsClient.isConnected()) return;
  const resampled = prepareFloat32ForWhisper(audio, sampleRate);      // resample to 16 kHz
  const int16 = float32ToInt16(resampled);                            // Float32 -> Int16 PCM
  this.totalAudioProcessed += resampled.length / 16000;
  const sent = this.wsClient.sendAudioFrame(int16);                   // raw Int16Array view, zero-copy
  if (sent === false) { this.droppedFrameCount++; this.onDropCallback?.(this.droppedFrameCount); }
}
```
**Chunking cadence — not a timer inside the WS client; it's set by the upstream AudioWorklet coalescing constant.** `packages/stt/src/worklets/stt-capture.worklet.ts:36`: `export const DEFAULT_STT_CAPTURE_FRAME_MS = 80;` — the worklet accumulates 128-sample render quanta into a buffer sized `targetSamples = Math.max(128, Math.round((sampleRate * frameMs) / 1000))` (worklet source string, line 67) and posts one coalesced `Float32Array` frame via `port.postMessage` whenever the buffer fills (lines 108-121). Doc comment (`stt-capture.worklet.ts:8-13`): "instead of posting every 128-sample render quantum (~2.7 ms at 48 kHz → ~375 messages/s)... posted as one coalesced frame every `frameMs` (default 80 ms → ~12 messages/s)." Each coalesced frame flows `AudioWorkletNode.port.onmessage` → `createAudioCapture`'s `onFrame` (`packages/stt/src/core/audioCapture.ts:122-127`) → `STTProcessor.setupAudioCapture`'s callback (`packages/stt/src/core/STTProcessor.ts:766-779`) → `provider.processAudio(frame, audioContext.sampleRate)`. Fallback path (no `AudioWorklet` support) uses `ScriptProcessorNode` with `SCRIPT_PROCESSOR_BUFFER_SIZE = 4096` (`audioCapture.ts:21`, ~85 ms at 48 kHz, driven by the native `onaudioprocess` callback, not a JS timer).

**d. Control frames — exact JSON shapes, verbatim:**
```ts
// sendStop() — SttWebSocketClient.ts:402-405
this.ws!.send(JSON.stringify({ type: 'stop' }));

// sendClose() — SttWebSocketClient.ts:410-413
this.ws!.send(JSON.stringify({ type: 'close' }));

// sendResumeHandshake() — SttWebSocketClient.ts:988-1005, fired automatically on reconnect-open
const handshake: WsResumeRequest = { type: 'resume', sessionId, lastSeq };
ws.send(JSON.stringify(handshake));
```
`WsResumeRequest` type (`types/stt.ts:170-176`):
```ts
export interface WsResumeRequest {
  type: 'resume';
  sessionId: string;
  lastSeq: number;
}
```

**e. Incoming schema — verbatim field lists.** Two layers: a tolerant wire payload, normalized into a strict result.

`WsTranscriptWirePayload` (raw, dual-cased, everything `unknown`) — `types/stt.ts:264-298`:
```ts
export interface WsTranscriptWirePayload {
  type?: unknown;
  text?: unknown;
  startTime?: unknown; start_time?: unknown;
  endTime?: unknown; end_time?: unknown;
  isFinal?: unknown; is_final?: unknown;
  stableChars?: unknown; stable_chars?: unknown;
  utteranceIndex?: unknown; utterance_index?: unknown;
  resultType?: unknown;
  seq?: unknown;
  englishText?: unknown; english_text?: unknown;
  speakerId?: unknown; speaker_id?: unknown;
  speakerLabel?: unknown; speaker_label?: unknown;
  speakerConfidence?: unknown; speaker_confidence?: unknown;
  speakerEmbedding?: unknown; speaker_embedding?: unknown;
  speakerFeatures?: unknown; speaker_features?: unknown;
  wordTimestamps?: unknown; word_timestamps?: unknown;
  inference?: unknown; inference_time?: unknown;
  [key: string]: unknown;
}
```
`WsTranscriptResult` (strict, post-`normalizeTranscript`) — `types/stt.ts:193-245`:
```ts
export interface WsTranscriptResult {
  type: 'transcript';
  text: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  stableChars?: number;
  utteranceIndex?: number;
  resultType?: 'segment' | 'gloss';
  seq?: number;
  englishText?: string;
  speakerId?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  speakerEmbedding?: number[];
  speakerFeatures?: Record<string, unknown>;
  wordTimestamps?: WsWordTimestamp[];
  inference?: number;
}
```
`normalizeTranscript` (`SttWebSocketClient.ts:650-787`) is the single tolerant coercion point: `text` missing → the whole message is dropped (`return null`, line 657-658); `isFinal`/`is_final` accepts boolean, `1`/`0`, or `'1'`/`'0'` via `coerceIsFinal` (lines 643-648), defaulting to `false` (never a premature final) when unparseable. Other server message types, verbatim:
```ts
// WsStatusMessage — types/stt.ts:317-323
export interface WsStatusMessage { type: 'status'; status: string; message: string; }
// WsErrorMessage — types/stt.ts:328-334
export interface WsErrorMessage { type: 'error'; code: string; message: string; }
// WsResumedMessage — types/stt.ts:341-346
export interface WsResumedMessage { type: 'resumed'; sessionId: string; fromSeq: number; }
// WsResumeFailedMessage — types/stt.ts:353-359
export interface WsResumeFailedMessage { type: 'resume_failed'; sessionId: string; reason: 'buffer_overflow' | 'unknown_session'; minAvailableSeq?: number; }
```
Handled in `handleMessage`'s `switch (msg.type)` (`SttWebSocketClient.ts:828-916`): cases `'transcript'`, `'resumed'`, `'resume_failed'`, `'status'`, `'error'`, `default` (logs "Unknown WebSocket message type"). `WsStatusMessage.status` doc example includes `'finalizing'` (`types/stt.ts:319`) and `StreamingSessionStatus = 'active' | 'finalizing' | 'closed' | 'rejected'` (`types/stt.ts:131`) — but **no code path in the SDK gates on a `'finalizing'` status** (see 3h below).

**f. Reconnect/backoff — exact numeric defaults and formula.**
`WsReconnectOptions` defaults (`SttWebSocketClient.ts:194-200`):
```ts
this.reconnectOptions = {
  enabled: reconnect?.enabled ?? false,
  maxAttempts: reconnect?.maxAttempts ?? 5,
  baseDelayMs: reconnect?.baseDelayMs ?? 1000,
  maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
  refreshTicket: reconnect?.refreshTicket ?? null,
};
```
Backoff formula, `attemptReconnect()` (`SttWebSocketClient.ts:545-547`):
```ts
const exponentialDelay = Math.min(this.reconnectOptions.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.reconnectOptions.maxDelayMs);
const jitter = Math.random() * exponentialDelay * 0.5;
const delay = Math.round(exponentialDelay + jitter);
```
So: pure exponential doubling (1000ms, 2000ms, 4000ms, 8000ms, 16000ms, capped at 30000ms), **additive** jitter of `0–50%` of the exponential value on top (i.e., actual delay ∈ `[exponentialDelay, 1.5×exponentialDelay]` — not the "full jitter"/decorrelated-jitter pattern, no randomization below the base value). `maxAttempts` default `5`; exhausting it fires `onReconnectFailedCb` (lines 522-531) and does not retry further unless `cancelReconnect()`/a fresh `connect()` resets `reconnectAttempts`. Before each attempt, if `reconnectOptions.refreshTicket` is set it's called to mint a fresh ticket and rewrite the URL (lines 567-583) — PluginManager wires this to `sessionManager.refreshTicket()` (`PluginManager.ts:761-763`); a failed refresh aborts the reconnect attempt entirely (`this.onReconnectFailedCb?.()`, line 580).
`acknowledgeConnection()` (TASK-2605, lines 494-505) resets `reconnectAttempts = 0` on the **first server message received after a reconnect** (called from `handleMessage`, lines 824-826) — so a genuinely-stable reconnect gets a fresh attempt budget for the *next* disconnect episode, while a flapping connection that closes before any message arrives keeps depleting the same budget.

**g. Buffering while disconnected — dropped, not queued.** The `WsBackpressureOptions` docblock (`SttWebSocketClient.ts:103-119`) claims: *"Without these limits, `audioQueue.length` and `ws.bufferedAmount` would grow unboundedly... We drop oldest frames once the queue exceeds `maxQueueSize`"* and `DEFAULT_MAX_QUEUE_SIZE = 200` is defined (line 140) — **but no `audioQueue` array field or any queue-length check exists anywhere in the class** (verified via full read + grep). The only backpressure mechanism actually wired up is `shouldDropForBufferedAmount()` (lines 936-940), which checks `ws.bufferedAmount >= bufferedAmountHighWatermark` (default `1 * 1024 * 1024` = 1 MiB, line 142) — this only fires while the socket is still `OPEN` and backed up, not while fully disconnected. While genuinely disconnected, `sendAudioFrame`/`sendAudioFrameJson` call `requireConnection()` (lines 632-636) which **throws** `Error('WebSocket not connected. Call connect() first.')`. The actual caller never reaches that throw, though: `StreamingBackendSTTProvider.processAudio()` guards with `if (!this.processing || !this.wsClient.isConnected()) { return; }` (`StreamingBackendSTTProvider.ts:226-228`) — so **audio frames captured during a disconnect window are silently dropped at the provider level** (no queue, no replay on reconnect). `maxQueueSize` is effectively dead configuration.

**h. Finalize-on-stop — no wait for a tail-final response; socket closes almost immediately after `sendStop()`.** Full chain on `audio.stop()`:
1. `useArcaAudio.stopAudio()` (`useArcaAudio.ts:331-390`) → `await pluginManager.destroy()`.
2. `PluginManager.destroy()` (`PluginManager.ts:1007-1047`) → `await this.transcriptionPipeline.destroy()`.
3. `TranscriptionPipeline.destroy()` (`TranscriptionPipeline.ts:574-578`) → `await this.stop()` (`TranscriptionPipeline.ts:340-402`), which iterates stages and calls `await stage.processor.destroy()` for each, including `'stt'`.
4. `STTProcessor` extends `BaseProcessor`; `BaseProcessor.destroy()` (`packages/room/src/processors/BaseProcessor.ts:126-144`) does `await this.onDestroy();` then immediately stops `processedTrack` — no delay.
5. `STTProcessor.onDestroy()` (`STTProcessor.ts:230-249`): `await this.provider.stop();` then (unless keeping a local provider warm) `await this.provider.destroy();`.
6. For the streaming remote provider, `StreamingBackendSTTProvider.stop()` (`StreamingBackendSTTProvider.ts:213-223`):
   ```ts
   async stop(): Promise<void> {
     if (!this.processing) return;
     this.processing = false;
     try { this.wsClient.sendStop(); } catch { /* best-effort */ }
   }
   ```
   — sends `{"type":"stop"}` and **returns immediately**; there is no `await` on any server acknowledgement, no listener registered for a "final" or "finalizing" status before proceeding.
7. `StreamingBackendSTTProvider.destroy()` (`StreamingBackendSTTProvider.ts:250-264`), called right after in the same chain: `await this.stop()` (no-op, already stopped) → `this.wsClient.disconnect()` → `await this.session.closeSession()`.
8. `SttWebSocketClient.disconnect()` (`SttWebSocketClient.ts:419-436`) is synchronous and immediate: `this.intentionalDisconnect = true; this.cancelReconnect(); ... ws.close(1000, 'Client disconnect');`.

**Conclusion:** there is **no state machine gate, timeout, or Promise that waits for a tail-final `transcript` message (or a `status:'finalizing'`/`'closed'` message)** between `sendStop()` and the WS `close(1000, ...)` — they happen back-to-back across a couple of `await` boundaries in the same `destroy()` call chain. This is consistent with (and likely the client-side counterpart of) the background context's P0 gateway fix, commit `0040fe3e` ("relay tail final (gateway) + tolerate redis read-timeout") — since the client tears the socket down almost immediately after requesting `stop`, the server must synchronously flush/relay the tail final as part of handling the `stop` frame itself rather than relying on a later async relay that could race the client hangup.

---

### 4. `StreamingSessionManager` relationship to `SttWebSocketClient`

`StreamingSessionManager` (`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`) does **not** own/wrap an `SttWebSocketClient` instance itself — it only owns the REST session lifecycle (`createSession` → `POST /audio/transcription-jobs/stream/session`, `refreshTicket`, `closeSession` → `DELETE .../session/{id}`) and computes the WS URL string via `getWebSocketUrl()`. The two are constructed as siblings by `PluginManager.buildStreamingTransport()` (`PluginManager.ts:757-772`) into one `streamingTransport` object `{ sessionManager, wsClient, pipelineId, consultationId }`, which flows through `TranscriptionPipelineConfig.stt.streamingTransport` → the `'stt'` stage factory (`TranscriptionPipeline.ts:161-215`) → `processor.setStreamingTransport(streamingTransport)` (`STTProcessor.ts:211`, interface at `STTProcessor.ts:338-340`) → `STTProcessor.initializeStreamingRemoteProvider()` (`STTProcessor.ts:713-757`), which constructs `new StreamingBackendSTTProvider({ sessionManager: transport.sessionManager, wsClient: transport.wsClient })` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:154-167`).

`StreamingBackendSTTProvider` (in the separate `@arcaai/stt` package, not `@arcaai/vox`) is the actual orchestrator that sequences both: `init()` (`StreamingBackendSTTProvider.ts:173-204`) calls `session.createSession(...)` then `session.getWebSocketUrl()` then `wsClient.connect(url)`; `destroy()` (lines 250-264) calls `stop()` → `wsClient.disconnect()` → `session.closeSession()`. `useArcaAudio.ts` never touches `StreamingSessionManager`/`SttWebSocketClient` directly — it only calls `pluginManager.setRuntimeOptions({pipelineId, consultationId, language})` (lines 80-84) before `pluginManager.initialize(track, audioContext)` (line 240); everything downstream is wired inside `PluginManager`/`TranscriptionPipeline`/`STTProcessor`/`StreamingBackendSTTProvider`.

---

### 5. Partial/final transcription events landing in `agenticStore.ts`

Producer: `useArcaAudio.startAudio()`'s `pluginManager.setCallbacks({ onTranscription })` (`useArcaAudio.ts:135-237`):
```ts
onTranscription: (result: TranscriptionResult) => {
  if (result.isFinal) {
    store.setCurrentTranscript('');
    const fallbackTime = Date.now();
    const segment: TranscriptSegment = {
      text: result.text,
      startTime: result.vadStreamStartSec ?? fallbackTime,
      endTime: result.vadStreamEndSec ?? fallbackTime,
      isFinal: true,
      speakerLabel: result.speakerId,
      confidence: result.confidence,
      language: result.language,
      words: result.words,
    };
    store.addTranscriptSegment(segment);
    ...
  } else {
    store.setCurrentTranscript(result.text);
  }
},
```
Store state shape (`packages/agentic-sdk-v2/src/store/agenticStore.ts`, `AgenticState`, lines 63-88):
```ts
currentTranscript: string;                 // line 68 — the ONE interim/partial scalar
transcriptSegments: TranscriptSegment[];    // line 69 — array, receives ONLY finals
```
Actions (`agenticStore.ts:443,445`):
```ts
setCurrentTranscript: (transcript) => set({ currentTranscript: transcript }),
addTranscriptSegment: (segment) => set((state) => ({ transcriptSegments: [...state.transcriptSegments, segment] })),
```
`addTranscriptSegment` is a **plain append with no id-based dedup/merge** (contrast `addContextItem`/`addEntities`, `agenticStore.ts:402-427`, which upsert by id).

**Key architecture finding:** `TranscriptSegment` (`packages/agentic-sdk-v2/src/types/audio.ts:240-253`) has an `isFinal: boolean` field and could in principle represent a partial, but the *only* producer (`useArcaAudio.ts`'s `onTranscription`) constructs it exclusively inside the `if (result.isFinal)` branch — so in practice `transcriptSegments` entries are always `isFinal: true`; nothing else lives there. Furthermore, `TranscriptionResult` (`types/audio.ts:102-147`) has **no `stableChars`, `resultType`, `utteranceIndex`, or `englishText` fields**, and `StreamingBackendSTTProvider.normalizeTranscript()` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:301-320`) only copies `text`/`isFinal`/`language`/`duration`/`speakerId`/`confidence`/`words` from the wire payload into `TranscriptionResult` — the TASK-351 P1-1 tentative-tail wire fields (`stableChars`, `resultType`, `utteranceIndex`) that `WsTranscriptResult` carries (§3e above) are **dropped before reaching the SDK store**. This matters directly for §6 below.

---

### 6. Live-transcript UI — partial/tentative vs. final rendering

`packages/ui/src/components/live-transcript/types.ts` — `LiveTranscriptSegment` (lines 17-34) is explicitly documented as "a superset of the SDK store `TranscriptSegment` AND the wire `WsTranscriptResult`" and *does* carry the tentative-tail fields:
```ts
export interface LiveTranscriptSegment {
  id: string;
  text: string;
  startTime?: number;
  endTime?: number;
  isFinal: boolean;
  stableChars?: number;      // "Committed-prefix length on partials (render the tail tentatively)."
  speakerLabel?: string;
  speakerConfidence?: number;
  confidence?: number;
  language?: string;
  englishText?: string;
  resultType?: 'segment' | 'gloss';
  utteranceIndex?: number;
  wordTimestamps?: LiveTranscriptWord[];
}
```
`transcript-segment.tsx`'s `SegmentBody()` (`packages/ui/src/components/live-transcript/transcript-segment.tsx:143-188`) is where the tentative-tail split actually happens:
```tsx
const baseClass = cn('text-sm leading-relaxed', segment.isFinal ? 'text-foreground' : 'italic text-muted-foreground');
...
// stableChars: committed prefix renders settled; the tail renders tentatively.
if (!segment.isFinal && segment.stableChars != null && segment.stableChars > 0 && segment.stableChars < segment.text.length) {
  return (
    <p className={baseClass}>
      <span className="not-italic text-foreground">{segment.text.slice(0, segment.stableChars)}</span>
      <span>{segment.text.slice(segment.stableChars)}</span>
    </p>
  );
}
return <p className={baseClass}>{segment.text}</p>;
```
i.e., the committed prefix (`0..stableChars`) is wrapped in `not-italic text-foreground` (overriding the parent's italic/muted look) while the tail inherits the parent `<p>`'s `italic text-muted-foreground` styling from `baseClass` — a genuine two-tone "settled vs. tentative" render. On the outer wrapper (`transcript-segment.tsx:79-86`):
```tsx
<div data-slot="transcript-segment" data-final={segment.isFinal ? 'true' : 'false'} aria-live={segment.isFinal ? undefined : 'off'} className="space-y-1 py-1.5">
```
— `data-final` is a styling/test-selector hook; `aria-live="off"` on interim rows explicitly avoids screen-reader spam (comment: "Interim rows are not announced by the live region").

**The `interim` prop is a separate, simpler mechanism.** `live-transcript.tsx:153-161`:
```tsx
{interim ? (
  <p data-slot="live-transcript-interim" aria-live="off" className={cn('italic text-muted-foreground', density === 'compact' ? 'px-3 py-1' : 'px-4 py-1.5')}>
    {interim}
  </p>
) : null}
```
`interim` (typed as a plain `string`, `LiveTranscriptProps.interim` at `types.ts:49`, documented as `` `audio.currentTranscript` — the live partial ``) is rendered flat italic, **outside** the virtualized segment array, with **no `stableChars` slicing** — it is always uniformly tentative.

**Consequence tying §5 and §6 together:** since `useArcaAudio`'s stock wiring only ever produces (a) fully-final `TranscriptSegment`s appended to `transcriptSegments`, and (b) a scalar `currentTranscript` string with no `stableChars`, a consumer using the vox SDK's default hooks feeding `LiveTranscript` can only ever exercise rendering path (a) `interim` (uniformly italic, no settled/tentative split) — the richer `SegmentBody` two-tone `stableChars` code path in the UI package is effectively **dead with the current SDK wiring** unless a caller independently constructs `LiveTranscriptSegment` objects with `isFinal:false`/`stableChars` from the raw WS payload, bypassing `useArcaAudio`/`agenticStore`.

---

### 7. `jump-to-live.tsx` and `listening-pulse.tsx` — UX feedback

**`JumpToLive`** (`packages/ui/src/components/live-transcript/jump-to-live.tsx`, full file): a `<Button size="sm" variant="secondary">` positioned `absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md` with an `ArrowDown` icon, label `hasBacklog ? 'New messages' : 'Jump to live'` (lines 25-26). Trigger condition, `live-transcript.tsx:166`: `{!ctrl.isPinnedToBottom ? <JumpToLive onClick={ctrl.jumpToLive} /> : null}` — **note this call site never passes `hasBacklog`**, so in the shipped component the button always reads "Jump to live", the "New messages" variant is unreachable dead code today.

`isPinnedToBottom` state and scroll logic live in `use-live-transcript.ts`:
```ts
const BOTTOM_THRESHOLD = 24;   // line 47
const TOP_THRESHOLD = 48;      // line 48

const onScroll = React.useCallback((event) => {           // lines 158-168
  const el = event.currentTarget;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  setIsPinnedToBottom(distanceFromBottom <= BOTTOM_THRESHOLD);
  if (el.scrollTop <= TOP_THRESHOLD && collection?.hasNextPage && !collection?.isFetchingNextPage) {
    collection?.fetchNextPage?.();                          // infinite-scroll-up for older history
  }
}, [collection]);

const jumpToLive = React.useCallback(() => {                // lines 170-174
  const el = scrollRef.current;
  if (el) el.scrollTop = el.scrollHeight;
  setIsPinnedToBottom(true);
}, []);

// Autoscroll effect — lines 177-181
React.useEffect(() => {
  if (!autoScroll || !isPinnedToBottom) return;
  const el = scrollRef.current;
  if (el) el.scrollTop = el.scrollHeight;
}, [autoScroll, isPinnedToBottom, displaySegments.length, interim]);
```
So auto-scroll-to-bottom fires whenever new final segments (`displaySegments.length`) *or* new interim/partial text (`interim`) arrive, but only while the `autoScroll` prop is enabled AND the user hasn't manually scrolled away from the bottom (`isPinnedToBottom`).

**`ListeningPulse`** (`packages/ui/src/components/live-transcript/listening-pulse.tsx`, full file): a small dot indicator.
```tsx
<span className="relative inline-flex size-2.5 items-center justify-center" aria-hidden="true">
  {active ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" /> : null}
  <span className={cn('relative inline-flex size-2.5 rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/40')} />
</span>
```
`active` (when true) adds a `animate-ping` overlay (`motion-reduce:hidden` respects `prefers-reduced-motion`, falling back to a static dot) and colors the base dot `bg-primary`; inactive is a static `bg-muted-foreground/40` dot. `active` is fully consumer-driven — `LiveTranscript` just forwards its own `isListening` prop (`live-transcript.tsx:67`: `<ListeningPulse active={isListening} label={isListening ? 'Listening' : 'Idle'} />`) with no internal computation from any store selector. A second usage appears in the empty+listening state (`live-transcript.tsx:104-108`, unconditionally `active`) paired with "Listening… start speaking." copy.

---

### 8. `ProcessedAudioTap.ts` and `DualStreamRecorder.ts`

**`DualStreamRecorder`** (`packages/agentic-sdk-v2/src/core/DualStreamRecorder.ts`, full file, 101 lines): records two parallel `MediaRecorder`s — one on a raw (pre-noise-filter) `MediaStreamTrack`, one on a processed (post-pipeline) track — via `makeRecorder()` (lines 77-86; `DEFAULT_MIME = 'audio/webm'`, line 22), yielding `{ raw: Blob; processed: Blob }` on `stop()` (lines 61-75). It is used directly by `useArcaAudio.startAudio()` (`useArcaAudio.ts:246-271`) **only when `options?.dualCaptureEnabled && workflowMode !== 'remote'`** — i.e., today it's a **local-workflow-only** feature: it pulls `pipeline.getRawInputTrack()`/`pipeline.getProcessedTrack()` from `TranscriptionPipeline` and, if both exist, starts recording; on `stopAudio()` (`useArcaAudio.ts:344-358`) it's flushed *before* pipeline teardown and the resulting blobs are delivered via the caller-supplied `onDualCapture` callback for upload/attach (`AudioStartOptions.onDualCapture` doc, `types/audio.ts:291-296`: "A consumer uploads each blob, then attaches both via `useAudioRecordings.add(consultationId, { mediaId, rawMediaId, processedMediaId })`. The SDK does not perform the upload itself"). Purpose: local on-device QA/playback recording of both the unprocessed mic and the noise-filtered/VAD-gated pipeline output from a single capture session.

**`ProcessedAudioTap`** (`packages/agentic-sdk-v2/src/core/ProcessedAudioTap.ts`, full file, 119 lines): `createProcessedAudioTap(rawStream, options)` builds an **independent, parallel** RNNoise processing graph (its own `createNoiseFilter()` instance, optionally its own owned `AudioContext` when none is passed) directly off a raw mic `MediaStream`, exposing the genuine post-noise-filter `MediaStream`/track for recording. Its doc (lines 8-23) explains the purpose precisely: *"some capture paths (e.g. a backend-STT live caption flow) stream the raw mic straight to the server and never drive the full local pipeline, so the pipeline's `getProcessedTrack()` is unavailable. This helper lets such a consumer obtain the real processed PCM for a parallel artifact (e.g. dual capture) from just the raw mic stream."* It's explicitly "opt-in & side-effect-free until called" (line 15) — **no call site to `createProcessedAudioTap` was found anywhere else in `packages/agentic-sdk-v2/src`**, so it currently exists unused as an escape hatch. It "fails loud" rather than silently degrading: `getNoiseFilterBrowserSupport()` is checked before any resource is created, throwing `` `createProcessedAudioTap: genuine RNNoise filtering unavailable (${reason})` `` when unsupported (lines 69-75), specifically to avoid silently recording an unfiltered stream via a native fallback.

**Relationship between the two:** `DualStreamRecorder` is the *mechanism* (records two tracks in parallel); `ProcessedAudioTap` is a *track source* that would let dual-capture work even in the backend/remote-streaming workflow (where `TranscriptionPipeline.getProcessedTrack()`/`getRawInputTrack()` may not reflect a genuine local NoiseFilter pass the way the local pipeline does). Today, `useArcaAudio`'s dual-capture branch is gated on `workflowMode !== 'remote'` only and never references `ProcessedAudioTap` — so remote/backend-streaming sessions currently have no dual-capture path, and `ProcessedAudioTap` is the (unused) building block that would enable one.
