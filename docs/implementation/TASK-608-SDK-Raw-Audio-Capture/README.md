# TASK-608 — SDK raw audio capture (no browser NS / AEC / AGC)

| Field | Value |
|---|---|
| Status | In Progress |
| Type | feature (SDK) + investigation |
| Branch | `dev-2.1` |
| Packages | `@arcaai/vox` (`packages/agentic-sdk-v2`) |
| Related | TASK-597 (source selection), TASK-586 (provider switch), TASK-560/561 (compat surface) |

## Requirement Analysis

For SDK/compat integrations the uplink to live transcription must carry the
**original** (or, for multi-mic, the **mixed**) audio stream:

1. no frontend VAD,
2. no noise suppression / cancellation,
3. no gain or volume modification.

Second, unrelated report to diagnose: an integrator selects a **multi-microphone
device fed by a Python app on another system** as the external microphone, and
**no data reaches the socket stream**.

## Current State Evaluation (audited before any change)

Path audited: `useAudioCapture` + `useArcaSpeechToText` (compat) →
`useArcaAudio.start()` → `PluginManager`/`TranscriptionPipeline` →
`STTProcessor` → `StreamingBackendSTTProvider` → WS.

| Stage | Finding | Evidence |
|---|---|---|
| Capture | `getUserMedia` called with **no audio constraints** ⇒ browser defaults apply, and Chrome/Edge/Safari default `echoCancellation`, `noiseSuppression`, `autoGainControl` to **ON** | `hooks/useArcaAudio.ts:265,271` |
| Mixing | Single source: track passed through, **no mixer node**. Multi-source: `AudioMixer` with per-source gain (default 1.0) + `1/√N` master | `packages/room/src/core/AudioMixer.ts:342` |
| Level meters | `AnalyserNode` taps, analysis-only, never in the signal path | `hooks/useArcaAudio.ts:296-321` |
| Noise filter (RNNoise) | Pipeline stage, only constructed when `enabled`. Compat emits it **only** if v1 `audioSettings.noiseSuppression` is stated; `AgenticProvider` does not merge defaults and `PluginManager` resolves a missing key to `{enabled:false}` ⇒ **OFF** for a `sttPipelineId`-only config | `compat/config-adapter.ts:43-66`, `core/TranscriptionPipeline.ts:726` |
| VAD | Same as above ⇒ **OFF**. Even when on it never gates the backend uplink: `useVadGate = runtimeProvider === 'local' && vad.enabled` | `core/TranscriptionPipeline.ts:168`, `stt/src/core/STTProcessor.ts:820` |
| Uplink | Worklet coalesces frames only (no gain); then sinc resample 48→16 kHz + Int16 clamp. `normalizeAudio` exists in `@arcaai/stt/utils` but is **never called** in the live path | `stt/src/worklets/stt-capture.worklet.ts`, `stt/src/providers/StreamingBackendSTTProvider.ts:296` |

**Conclusion:** requirements 1 and (SDK-side) 2 already hold. The gap is the
**browser's** APM — on by default, and `AudioStartOptions` exposed no way to
turn it off. AGC in particular directly violates requirement 3.

## Implementation Plan

1. RED — test the `getUserMedia` constraint shape for: raw request, deviceId
   merge, every source of a multi-mic capture, partial keys, and the
   byte-identical pre-608 shape when omitted.
2. GREEN — `AudioProcessingConstraints` on `AudioStartOptions`, spread into the
   constraints of every resolved source.
3. Forward through the compat `useAudioCapture` (the boundary a v1-migrating app
   actually starts capture from).
4. Export the type from the types barrel.

## Implementation Summary

| File | Change |
|---|---|
| `src/types/audio.ts` | New `AudioProcessingConstraints`; `AudioStartOptions.audioProcessing` |
| `src/types/index.ts` | Export the new type |
| `src/hooks/useArcaAudio.ts` | Build the constraint object from the stated keys and spread it into **both** `getUserMedia` branches |
| `src/compat/useAudioCapture.ts` | New `audioProcessing` prop, spread into `audio.start(...)` only when at least one key is stated |
| `src/hooks/__tests__/useArcaAudio.audioProcessing.task608.test.ts` | 6 tests |
| `src/compat/__tests__/useAudioCapture.audioProcessing.task608.test.ts` | 3 tests |

Usage:

```ts
const capture = useAudioCapture({
  deviceId: selectedDeviceId,
  audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
});
```

Back-compat: only stated keys are emitted; an omitted or empty object keeps the
pre-608 request exactly (`{ audio: true }` for the default mic — **not**
`{ audio: {} }`, which is a different request). `sourceStreams` callers are
unaffected: they built the streams and own their own constraints.

### Verification

```
vitest run (packages/agentic-sdk-v2)   → 230 files, 3853 tests passed
tsc --noEmit                            → clean
eslint                                  → 0 errors, 4 warnings (all pre-existing)
build (tsup + dts)                      → success
```

Runtime verification (real microphone + running gateway) is owner-side: start a
session with `audioProcessing` all-`false` and confirm
`track.getSettings()` reports `autoGainControl: false` and that a constant-level
tone no longer drifts in amplitude across the session.

## Investigation — multi-mic device selected, no data on the socket

Ranked by likelihood, each with the code that produces the symptom.

### 1. The start race silently discards `deviceId` (primary suspect)

`useAudioCapture.startRecording()` and `useArcaSpeechToText.startTranscription()`
drive the **same** `useArcaAudio` instance and both guard on `audio.isCapturing`
— the first through applies its options, the second returns immediately
(`compat/useAudioCapture.ts:157`, `compat/useArcaSpeechToText.ts:222`).

`useArcaSpeechToText` has **no device props at all**, so when it wins the race
`getUserMedia({ audio: true })` opens the **default** mic and every source option
(`deviceId`, `secondaryDeviceId`, `sourceGains`) is dropped **with no error**.

The reference app starts in exactly that order, and its own comment states the
assumption that makes it safe — an assumption an integrator with device
selection breaks:

> `apps/quick-compat-app/src/components/LiveTranscription.tsx:68` — "TRANSCRIPTION FIRST, capture second… this app selects no capture devices, so nothing is lost by letting the STT hook win the race."

Result: the UI shows the multi-mic selected while the browser records the default
device. If that default is absent/muted/a virtual sink with no writer, the socket
carries silence or nothing useful. **There is deliberately no store-backed
fallback for device ids** (a `MediaStream` is a live, non-serializable resource),
so capture must be started from the hook that carries the selection.

*Check:* log the resolved track — `audio.activeStream.getAudioTracks()[0].label`
— right after start. If it is not the selected device, this is the cause.
*Fix:* call `capture.startRecording()` **first** when devices are selected. Note
the trade-off documented at that call site: the STT hook is the only one that
carries `pipelineId`, and `activePipeline` is set only when `audio.start()`
receives one, so capture-first disables live provider switching. Either pass the
pipeline through `useAudioCapture({ options: { sttPipelineId } })` as well, or
accept the loss of the switch.

### 2. Browser APM zeroing a virtual / loopback device

The Python-fed device is virtual. Chrome's APM (AEC/NS/AGC — all on by default,
see above) routinely mishandles virtual devices' clocking and channel layouts and
can emit **all-zero samples**. Frames flow, the socket carries bytes, and the
transcript stays empty. This is precisely what TASK-608 makes fixable:
`audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }`.

### 3. Multi-channel device where channel 0 is not the audio

The capture worklet reads **channel 0 only** (`const channel = input && input[0]`,
`stt/src/worklets/stt-capture.worklet.ts:103`). A mic array or virtual device
that puts speech on channels 1..N — or reserves channel 0 as a reference/loopback
channel — yields silence. `getUserMedia` is called without `channelCount`, so the
browser picks the layout.

*Check:* `track.getSettings().channelCount`. If > 1, this is a live suspect. A
`channelCount` constraint is a candidate follow-up (deliberately out of scope
here — three switches were the stated requirement).

### 4. Frames captured but the socket is not open

`StreamingBackendSTTProvider.processAudio` returns early when
`!this.processing || !this.wsClient.isConnected()`
(`stt/src/providers/StreamingBackendSTTProvider.ts:290`) — a silent drop, zero
bytes sent.

*Discriminator (run this first, it splits the whole space):* read
`useArcaAudio().uplinkBitrate` (polled every 1 s, `hooks/useArcaAudio.ts:1066`).

| `uplinkBitrate` | Meaning |
|---|---|
| `> 0` | Frames ARE reaching the socket → cause is upstream: silence, wrong channel, or wrong device (causes 1–3) |
| `== 0` | Nothing sent → socket not connected/`processing` false (cause 4), or the worklet is producing no frames (dead device, suspended `AudioContext`) |

### 5. Stale `deviceId`

`deviceId` is requested with `{ exact }` (`useArcaAudio.ts:271`). Device ids
rotate per origin/permission-state; a stale id rejects with
`OverconstrainedError`. Unlike causes 1–4 this **does** surface — through
`useAudioCapture`'s `onError` — so it is last. Re-enumerate devices after
permission is granted.

## Change History

| Date | Change |
|---|---|
| 2026-08-04 | Ticket opened. Audited the compat live path; added `audioProcessing` (SDK + compat) with 9 TDD tests; documented the multi-mic no-data investigation. |
