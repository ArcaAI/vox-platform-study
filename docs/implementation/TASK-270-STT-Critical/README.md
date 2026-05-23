# TASK-270 — @arcaai/stt Critical Fixes

**Ticket:** TASK-270 (child of TASK-262)
**Created:** 2026-05-23
**Updated:** 2026-05-23
**Status:** Completed
**Owner:** Agent A8

---

## Requirement Analysis

### Description

`docs/implementation/TASK-262-Vox-SDK-Deep-Assessment/04-stt.md` flagged five
critical/high defects in `@arcaai/stt` that must be fixed before the SDK can be
considered production-ready:

| ID | Defect | Severity |
|---|---|---|
| C-1 | `STTOptions.prompt` accepted but never reaches Whisper `initial_prompt` | Critical |
| C-2 | Audio `Float32Array` copied by structured-clone in worker `postMessage` | Critical |
| C-3 | `ScriptProcessorNode` capture (deprecated, main-thread, may be removed) | Critical |
| H-2 | `worker.onerror` only rejects first pending request; no crash recovery | High |
| H-6 | Linear reconnect backoff, no `destroyed` flag — reconnects fire after disconnect | High |

### Business Context

These defects directly affect production stability and medical-accuracy of the
local Whisper path used by the Vox SDK:

- **C-1** prevents the documented `prompt` mechanism (primary lever for reducing
  medical-terminology hallucination) from doing anything in local mode.
- **C-2** causes ~1.9 MB structured-clone copies on every 30 s transcription
  (~230 MB GC pressure per hour).
- **C-3** uses a deprecated audio API that browsers may remove and that produces
  audible glitches on the main thread.
- **H-2** silently hangs the local provider after a worker crash with no recovery.
- **H-6** hammers a briefly-down server and keeps reconnecting after the user
  explicitly disconnected.

### Acceptance Criteria

1. `STTOptions.prompt` flows: SDK -> `LocalProviderConfig.prompt` -> worker
   `transcribe` message -> Transformers.js pipeline option `initial_prompt`.
2. Audio `Float32Array` buffers sent via `postMessage` are transferred (zero-copy).
3. Audio capture uses `AudioWorkletNode` when `navigator.audioWorklet` is available;
   falls back to `ScriptProcessorNode` with a `console.warn` otherwise.
4. Worker crashes trigger automatic restart with exponential backoff (max 3 retries)
   and surface a typed `STTWorkerCrashError` to listeners.
5. WebSocket reconnect uses jittered exponential backoff
   (`min(cap, base * 2^attempt) * Math.random()`) and a `destroyed` flag blocks
   reconnects after `disconnect()` / `destroy()`.

### Out of Scope (assigned to other agents / future tickets)

- C-1/C-2/C-3 fixes that touch other packages (`@arcaai/room`, `@arcaai/vox`).
- The remaining items from `04-stt.md` (H-1, H-3, H-4, H-5 and all M-/L-/S-/P-
  items) — separate tickets.

---

## Current State Evaluation

### Files touched

| File | Role | Current shape |
|---|---|---|
| `src/types/index.ts` | `LocalProviderConfig` | No `prompt` field |
| `src/engines/types.ts` | `TranscribeOptions` | `prompt?: string` already defined but unused |
| `src/engines/WhisperEngine.ts` | Main-thread Whisper | Builds `transcribeOptions` without `initial_prompt` |
| `src/engines/WhisperWorkerEngine.ts` | Worker proxy | Doesn't forward `prompt`; `postMessage` by clone; rejects only first pending on crash |
| `src/workers/whisper.worker.ts` | Worker entry | `TranscribePayload.options` lacks `prompt`; pipeline call doesn't pass `initial_prompt` |
| `src/providers/LocalSTTProvider.ts` | Local provider | `transcribeSegment` calls engine with no options |
| `src/core/STTProcessor.ts` | Processor | `ScriptProcessorNode` capture; `prompt` not forwarded to local config |
| `src/websocket/WebSocketClient.ts` | WS client | Linear backoff; no `destroyed` flag |

### Worklet loader pattern (reused)

`@arcaai/room` already exports `createWorkletLoader` (used by `@arcaai/vad` and
`@arcaai/noise-filter`). C-3 reuses this same factory with an STT-specific
processor source so all three audio packages share the same blob-URL +
registration flow.

---

## Implementation Plan

### TDD Order (RED → GREEN → REFACTOR per item)

| Item | Test file | Source files |
|---|---|---|
| C-1 | `prompt-wiring.test.ts` | `types/index.ts`, `engines/types.ts`, `engines/WhisperEngine.ts`, `engines/WhisperWorkerEngine.ts`, `workers/whisper.worker.ts`, `providers/LocalSTTProvider.ts`, `core/STTProcessor.ts` |
| C-2 | `worker-transferable.test.ts` | `engines/WhisperWorkerEngine.ts` (+ JSDoc on `TranscribePayload`) |
| C-3 | `worklet-capture.test.ts`, `stt-capture-worklet.test.ts` | `worklets/stt-capture.worklet.ts` (new), `worklets/worklet-loader.ts` (new), `core/STTProcessor.ts` |
| H-2 | `worker-crash-recovery.test.ts` | `engines/WhisperWorkerEngine.ts` (+ `errors.ts` for `STTWorkerCrashError`) |
| H-6 | `websocket-backoff-destroyed.test.ts` | `websocket/WebSocketClient.ts` |

### Verification

```
pnpm --filter @arcaai/stt build
pnpm --filter @arcaai/stt test
pnpm --filter @arcaai/stt lint
pnpm --filter @arcaai/vox build   # downstream smoke
```

ReadLints on every modified file. Evidence captured in §Implementation Summary
once tests are green.

---

## Implementation Summary

All five items implemented under strict TDD (RED → GREEN → REFACTOR).

### C-1 — Wire `prompt` to Whisper

- `STTOptions.prompt` is now plumbed end-to-end:
  - `STTProcessor.initializeLocalProvider` copies `this.options.prompt` into
    `LocalProviderConfig.prompt`.
  - `LocalSTTProvider.transcribeSegment` reads it back and forwards it via
    `TranscribeOptions.prompt` to `engine.transcribe(audio, { prompt })`.
  - Both engines pass `initial_prompt` to Transformers.js:
    - `WhisperEngine.transcribe` (main-thread path).
    - `WhisperWorkerEngine` -> worker message payload -> `whisper.worker.ts`
      `transcribe()` -> `whisperPipeline(audio, { ..., initial_prompt })`.
- `prompt: undefined` and empty string are dropped (no `initial_prompt` set on
  the pipeline call) so existing behaviour is preserved when callers omit it.

### C-2 — Transferable `postMessage`

- `WhisperWorkerEngine.sendWorkerRequest` now accepts a `transfer?: Transferable[]`
  argument and forwards it as the second `postMessage` argument.
- `WhisperWorkerEngine.transcribe` passes `[audio.buffer]` as the transfer list,
  which detaches the underlying `ArrayBuffer` on the main thread and avoids the
  ~1.9 MB structured-clone copy per 30 s window.
- Worker -> main return path: `whisper.worker.ts` already returns a plain
  `TranscriptionResult` (no `Float32Array`); no transfer list needed downstream.
- JSDoc on `TranscribePayload` documents that audio buffer ownership is
  transferred and the main-thread copy is detached after `postMessage`.

### C-3 — `AudioWorkletNode` capture

- New module `src/worklets/stt-capture.worklet.ts` defines an inlined
  `AudioWorkletProcessor` (`stt-capture-processor`) that emits Float32 frames to
  the main thread via `port.postMessage` with the underlying buffer in the
  transfer list. Helpers (`registerSTTCaptureWorklet`,
  `createSTTCaptureWorkletNode`, `cleanupSTTCaptureWorkletResources`) wrap blob
  URL creation, `audioWorklet.addModule`, and node construction.
- New `src/core/audioCapture.ts` exports `createAudioCapture(audioContext, track,
  onFrame)` returning an `AudioCaptureHandle` (`{ dispose }`):
  - Branches on `isAudioWorkletUsable(audioContext)` — `navigator.audioWorklet`
    feature detect plus `typeof AudioWorkletNode === 'function'`.
  - **Worklet path:** registers worklet module once, creates
    `AudioWorkletNode`, wires `port.onmessage` to `onFrame`, connects via a
    `MediaStreamAudioSourceNode` -> worklet, leaves output disconnected so no
    audio is monitored.
  - **Fallback path:** `ScriptProcessorNode` with a one-shot `console.warn`
    documenting the deprecation; emits the same shaped frames to `onFrame`.
- `STTProcessor.setupAudioCapture` now stores a single `captureHandle` instead
  of three separate nodes, and `disposeAudioPipeline` calls `captureHandle.dispose()`.

### H-2 — Worker crash recovery + `STTWorkerCrashError`

- New `src/engines/errors.ts` defines `STTWorkerCrashError` (typed error with
  `name`, optional cause).
- `WhisperWorkerEngine` constructor now accepts `WhisperWorkerEngineOptions`
  (`maxCrashRetries` default 3, `crashBackoffBaseMs` default 100).
- New state: `crashRetryAttempts`, `crashPermanent`, `destroyed`, `restartTimer`.
- `initWithWorker` wires `worker.onerror` to `handleWorkerCrash(error)`:
  - Rejects **all** in-flight requests with `STTWorkerCrashError` (not just the
    first one, fixing H-2's symptom).
  - Terminates the existing worker, resets `isInitialized`/`initPromise`.
  - Schedules a restart with exponential backoff
    (`crashBackoffBaseMs * 2^(attempt-1)`) up to `maxCrashRetries` attempts;
    after the cap, marks `crashPermanent = true` and `transcribe()` rejects
    immediately with `STTWorkerCrashError`.
  - `destroy()` sets `destroyed = true`, clears any pending `restartTimer`, and
    terminates the worker so no further restarts fire.

### H-6 — Jittered exponential backoff + `destroyed` flag (WebSocket)

- `WebSocketClient`:
  - New `RECONNECT_BACKOFF_CAP_MS` constant (30 000 ms).
  - New `destroyed` flag and `reconnectTimer` handle.
  - `connect()` throws `Error('WebSocketClient is destroyed')` if `destroyed`.
  - `scheduleReconnect()` computes
    `delay = min(cap, base * 2^(attempts-1)) * Math.random()` (full jitter) and
    stores the `setTimeout` handle in `reconnectTimer`.
  - `handleClose` now **always** transitions to `'disconnected'` before deciding
    whether to schedule a reconnect (previously the state stayed `'connected'`
    while a reconnect was pending, which let stale `connect()` calls early-out).
  - `disconnect()` and new `destroy()` clear `reconnectTimer` and reset
    `reconnectAttempts`; `destroy()` additionally sets `destroyed = true`.

### Files modified

| File | Reason |
|---|---|
| `packages/stt/src/types/index.ts` | Add `prompt?: string` to `LocalProviderConfig` (C-1) |
| `packages/stt/src/engines/WhisperEngine.ts` | Forward `initial_prompt` to Transformers.js (C-1) |
| `packages/stt/src/engines/WhisperWorkerEngine.ts` | C-1, C-2, H-2 (prompt forwarding, transfer list, crash recovery) |
| `packages/stt/src/engines/errors.ts` | New: `STTWorkerCrashError` typed error (H-2) |
| `packages/stt/src/engines/index.ts` | Re-export `STTWorkerCrashError` |
| `packages/stt/src/workers/whisper.worker.ts` | Accept `prompt` in `TranscribePayload.options`, pass `initial_prompt` (C-1) |
| `packages/stt/src/providers/LocalSTTProvider.ts` | Read `prompt` from `LocalProviderConfig`, pass via `TranscribeOptions` (C-1) |
| `packages/stt/src/core/STTProcessor.ts` | Forward `prompt` to local provider config + replace ScriptProcessor capture (C-1, C-3) |
| `packages/stt/src/core/audioCapture.ts` | New: `createAudioCapture` helper with feature detect (C-3) |
| `packages/stt/src/worklets/stt-capture.worklet.ts` | New: worklet processor + registration helpers (C-3) |
| `packages/stt/src/websocket/WebSocketClient.ts` | H-6: jittered backoff + `destroyed` flag |

### Tests added (all colocated under `src/__tests__/`)

| Test file | Covers |
|---|---|
| `prompt-wiring.test.ts` | C-1 — prompt flows SDK -> engine -> pipeline call |
| `worker-transferable.test.ts` | C-2 — `postMessage` called with `[audio.buffer]` as transfer list |
| `audioCapture.test.ts` | C-3 — `AudioWorklet` preferred, `ScriptProcessor` fallback with warning |
| `sttCaptureWorklet.test.ts` | C-3 — worklet registration, source generation, node creation, cleanup |
| `worker-crash-recovery.test.ts` | H-2 — worker restart with backoff, in-flight rejection, permanent failure after cap, `STTWorkerCrashError` surface |
| `websocket-backoff-destroyed.test.ts` | H-6 — jittered exponential delays, cap, destroyed flag aborts mid-reconnect |

### Verification evidence

**`pnpm --filter @arcaai/stt test`** — 17 files / 306 tests passing:

```
 Test Files  17 passed (17)
      Tests  306 passed (306)
   Duration  1.25s
```

**`pnpm --filter @arcaai/stt build`** — clean ESM + CJS + worker + DTS output:

```
CJS dist/index.js                       102.80 KB
ESM dist/index.mjs                      100.17 KB
ESM dist/workers/whisper.worker.mjs       1.69 MB
DTS dist/index.d.ts                      56.98 KB
DTS dist/index.d.mts                     56.98 KB
```

**`pnpm --filter @arcaai/stt lint`** — exits 0 (single deprecation warning from
the eslintrc shim is pre-existing tooling noise, not a rule violation).

**`ReadLints` on every modified file** — `No linter errors found.`

**Downstream smoke — `pnpm --filter @arcaai/vox build`** — succeeds. The
existing `import.meta` warnings from the bundler are pre-existing and unrelated
to this ticket.

### Deviations

- **`tsup` DTS run is occasionally flaky on the first invocation** when both
  `@arcaai/room` and `@arcaai/stt` rebuild concurrently; a second
  `pnpm --filter @arcaai/stt build` run is deterministic. No source change
  needed — captured here for follow-up tickets that consolidate the build
  pipeline.
- **Pre-existing TypeScript errors in `src/hooks/useSTT.ts`** (calls to
  `processor.destroy()` / `processor.on()` / `processor.off()` not present on
  `STTProcessor`) and missing `@arcaai/room` declarations under `tsc --noEmit`
  are unchanged by this ticket. Build (`tsup` DTS) succeeds; only the standalone
  `pnpm --filter @arcaai/stt typecheck` script surfaces them. Out of scope per
  TASK-270 (the public API of `@arcaai/stt` is unaffected). Recommend a
  follow-up ticket to align the hook with the current `STTProcessor` surface.

---

## Change History

### 2026-05-23 — TASK-270 initial implementation

- C-1, C-2, C-3, H-2, H-6 landed together under strict TDD. See Implementation
  Summary above for the full list of files and tests.
- All `@arcaai/stt` verification gates green; `@arcaai/vox` build smoke green.
- No changes to `@arcaai/room` public API; consumed only.
