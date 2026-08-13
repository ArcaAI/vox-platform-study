# TASK-609 — SDK runtime audio-source management

| Field | Value |
|---|---|
| Status | Review |
| Type | feature (SDK) |
| Branch | `dev-2.1` |
| Packages | `@arcaai/vox` (`packages/agentic-sdk-v2`) |
| Related | TASK-608 (raw capture), TASK-597 (source selection), TASK-560/561 (compat surface) |

## Requirement Analysis

Integrators need the end user to select an audio source — possibly SEVERAL,
possibly connected at runtime — have the SDK capture them, normalize them into
one stream, and forward that to the socket once transcription starts.

Capture → mix → uplink already worked (TASK-597 + TASK-608). The gaps were at
the two ends: **discovering** devices at runtime, and **changing** the selection
without destroying the session. Four defects, agreed with the owner:

1. No runtime device discovery in the SDK (no `devicechange` listener anywhere).
2. No mid-session source changes, despite `AudioMixer` supporting them.
3. No device-loss detection — an unplugged mic died silently.
4. The dual-hook start race dropped capture options with no warning.

## Current State Evaluation

| Fact | Evidence |
|---|---|
| `AudioMixer` already supports runtime `addSource` / `removeSource` / `setSourceGain` / `muteSource`, attaches an analyser to a source added while monitoring runs, stops a removed source's tracks, and recomputes `1/√N` on every change | `packages/room/src/core/AudioMixer.ts:98-155` |
| `useArcaAudio` built the mixer inside `start()` and never exposed it — no caller outside `start` | grep |
| A single-source session has NO mixer; the device track is fed straight to the pipeline (pre-597 behaviour) | `useArcaAudio.ts` mixer block |
| Nothing listened for `devicechange` or track `ended` | grep: only `enumerateDevices` in `compat/useAudioCapture.ts:246` |
| Both compat hooks call `audio.start()` guarded by `isCapturing`; the loser's options are discarded at INFO level | `compat/useAudioCapture.ts:157`, `compat/useArcaSpeechToText.ts:222` |
| `useAudioCapture` DOES carry the pipeline id, via `options.sttPipelineId` — so capture-first costs nothing | `compat/useAudioCapture.ts:161` |

The last row matters: the reference app's comment at
`apps/quick-compat-app/src/components/LiveTranscription.tsx:53-68` claims
`useAudioCapture` has no pipeline prop and therefore starts the STT hook first.
That is out of date, and it is what makes device selection unreachable in a
capture-first app. **Not corrected in this ticket** (app-side change, separate
review) — flagged here so the next reader does not re-derive it. Corrected in
TASK-611, which also fixed a latent metadata-timeline-anchor defect the
capture-first flip exposed.

## Implementation Summary

### 1. `useArcaDevices()` — runtime discovery (new, provider-free)

`src/hooks/useArcaDevices.ts`. Returns `devices`, `permission`, `isSupported`,
`refresh()`, `requestPermission()`, `resolveDeviceId(pref)`.

- Audio inputs only; subscribes to `devicechange` and unsubscribes on unmount.
- `permission` is derived from label readability (the only reliable
  cross-browser signal), with a sticky `denied` after a refusal.
- `requestPermission()` opens a probe stream, **stops it immediately** (so the
  recording indicator does not stay lit behind the picker), then re-enumerates.
- `resolveDeviceId()` implements the identity rule: **exact id → (label,
  groupId) → label → `undefined`**. It returns `undefined` rather than guessing —
  `deviceId` rotates per origin/permission state, and the SDK requests it with
  `{ exact }`, so a persisted id alone eventually throws `OverconstrainedError`.
- Deliberately store-free: a picker must render before any session exists.

### 2. Mid-session source management on `useArcaAudio`

New: `addSource({ deviceId | stream, gain? }) → Promise<string>`,
`removeSource(id)`, `setSourceGain(id, gain)`, plus `sourceIds` (store-backed,
index-aligned with `sourceLevels`) and `AudioStartOptions.dynamicSources`.

The pipeline is initialized with ONE track, so sources are only swappable when
that track is the mixer's stable output. `dynamicSources: true` therefore builds
a mixer even for a single source; sessions started with ≥2 sources already have
one and need no flag. Adding a source performs **no** `pluginManager.initialize`
— asserted in test — so the WebSocket session and transcript survive.

Decisions worth keeping:

- **Runtime adds inherit the session's `audioProcessing`** (TASK-608), parked on
  a ref at start. Otherwise a late mic joins DSP'd into a raw-capture mix.
- **Ids are monotonic and never reused.** A recycled `source-2` would let a UI's
  stale handle re-gain or drop whatever took its place.
- **Removing the last source is refused** — an empty mix is silence on an open
  socket, i.e. the exact failure class this work exists to eliminate. Use `stop()`.
- A failed `mixer.addSource` rolls the id back and releases the mic it opened.
- The mixer's `1/√N` master normalization is recomputed on add/remove, so joining
  a second mic drops the mix ~3 dB. Deliberate summation headroom; documented on
  the option rather than special-cased.

### 3. Device-loss detection

Every source track gets an `ended` listener; firing logs a warning and sets
`audioError` naming the device. Watchers are attached before anything downstream
can fail and detached **before** teardown stops the tracks — otherwise a normal
Stop would post a bogus "device disconnected" error, and a failed start would
have its real error overwritten.

Reporting only: auto-removing the lost source would silently change the mix's
master gain without the user's say-so.

### 4. The ignored start now warns

`startAudio`'s already-active guard escalates INFO → WARN when the ignored call
carried capture-shaped options (`deviceId`, `secondaryDeviceId`,
`additionalDeviceIds`, `sourceStreams`, `sourceGains`, `audioProcessing`,
`dynamicSources`), listing them in `attributes.droppedOptions`. Language and
pipeline id stay at INFO — that is the normal dual-hook path.

### 5. `mute()`/`unmute()` now act on every source, not just `activeStream`

New `applyEnabledToAllSources(enabled)` in `useArcaAudio.ts`, called by
`muteAudio`/`unmuteAudio` instead of touching `activeStream` alone. It walks
`[...sourceStreamsRef.current, ...(activeStream ? [activeStream] : [])]`,
de-duplicates by `MediaStreamTrack` identity (a `Set`, since `activeStream` is
also the first entry of `sourceStreamsRef`), and sets `track.enabled` on each
distinct track.

- **Mechanism stays `track.enabled`, not `AudioMixer.muteSource`.** The mixer
  method would mute post-mix gain per source; `track.enabled` mutes at the
  hardware-capture boundary, which is what the pre-existing single-source
  `mute()` already did. Extending the same mechanism to every source keeps the
  observable contract (no audio reaches the mixer input) unchanged for
  existing single-source callers.
- **A source added by `addSource()` while the session is muted starts muted.**
  In `addSource`, after the mixer accepts the stream and before the id is
  registered in `sourceStreamsRef`, the new tracks are set `enabled = false`
  when `store.isMuted` is true. Without this, a mic joined mid-mute would be
  audible for however long elapses before the next explicit `mute()` call —
  silent inconsistency the source-management work exists to avoid.
- `removeSource` is unaffected: the mixer stops that source's tracks, and the
  stopped stream is left in `sourceStreamsRef` (pre-existing ref-retention
  behaviour). A later `unmute()` will set `enabled = true` on an already-ended
  track, which is a browser no-op.

### 6. `dynamicSources` forwarded through the compat `useAudioCapture` prop list

`compat/useAudioCapture.ts` gained `dynamicSources?: boolean` on
`UseAudioCaptureProps`, spread into the underlying `audio.start(...)` call —
**only when `true`** (`...(dynamicSources ? { dynamicSources } : {})`), mirroring
the existing conditional spread used for `audioProcessing` and the other
source options. An unconditional spread would add the key even when the prop
is `false` or `undefined`, which would break the exact-equality assertions in
sibling test files (TASK-608, TASK-597) that expect a byte-identical
pre-TASK-609 options object when the prop is omitted. This closes the gap
noted in the original "Recommended integration" snippet below — the compat
playground can now request a mixer for a single source without calling the
native `useArcaAudio` hook directly.

### Files

| File | Change |
|---|---|
| `src/hooks/useArcaDevices.ts` | New hook |
| `src/hooks/useArcaAudio.ts` | Source registry refs, `dynamicSources` mixer path, `addSource`/`removeSource`/`setSourceGain`, loss watchers, dropped-option warning, teardown, `applyEnabledToAllSources` (all-source mute) |
| `src/types/audio.ts` | `AudioStartOptions.dynamicSources` |
| `src/store/agenticStore.ts` | `audioSourceIds` + `setAudioSourceIds` (initial state, both reset paths) |
| `src/hooks/index.ts`, `src/core.ts` | Export `useArcaDevices` + its types |
| `src/compat/useAudioCapture.ts` | `dynamicSources?: boolean` prop, conditionally spread into `audio.start(...)` |
| `src/hooks/__tests__/useArcaDevices.task609.test.ts` | 13 tests |
| `src/hooks/__tests__/useArcaAudio.dynamicSources.task609.test.ts` | 10 tests |
| `src/hooks/__tests__/useArcaAudio.deviceLoss.task609.test.ts` | 4 tests |
| `src/hooks/__tests__/useArcaAudio.muteAllSources.task609.test.ts` | New, 5 tests |
| `src/compat/__tests__/useAudioCapture.dynamicSources.task609.test.ts` | New, 4 tests |

### Recommended integration

```tsx
const { devices, permission, requestPermission, resolveDeviceId } = useArcaDevices();
// picker → persist { deviceId, label, groupId } per selection

const capture = useAudioCapture({
  options: { sttPipelineId: pipelineId },   // keeps activePipeline + provider switching
  language, languageMode: language,
  deviceId: resolveDeviceId(saved[0]),
  additionalDeviceIds: saved.slice(1).map(resolveDeviceId).filter(Boolean),
  audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  dynamicSources: true,
});

await capture.startRecording();      // FIRST — this hook carries the sources
await stt.startTranscription();

// later, without dropping the session:
const id = await audio.addSource({ deviceId: roomMicId });
audio.setSourceGain(id, 1.4);
audio.removeSource(id);
```

`dynamicSources` is now forwarded through the compat `useAudioCapture` prop
list (see §6) as well as a native `useArcaAudio` start.

### Verification

```
vitest run (packages/agentic-sdk-v2)   → 235 files, 3887 tests passed
tsc --noEmit                            → clean
eslint                                  → 0 errors, 3 warnings (pre-existing: 2 in AgenticProvider.tsx,
                                           1 in useArcaConfig.ts — all `eslint-comments/no-unlimited-disable`)
build (tsup + dts)                      → success
```

Not verified at runtime: real multi-device hot-plug needs physical microphones
and a running gateway. Owner check — start with `dynamicSources: true`, plug in
a second mic, `addSource`, and confirm the transcript continues uninterrupted
while `sourceLevels`/`sourceIds` grow by one.

## Known limitations (remaining, deliberately out of scope)

- **`channelCount` is still unconstrained**, and the capture worklet reads
  channel 0 only. Left until the owner reports `getSettings().channelCount` from
  the real array (see TASK-608 investigation §3).

## Change History

| Date | Change |
|---|---|
| 2026-08-04 | Ticket opened and implemented: `useArcaDevices`, runtime source management, device-loss detection, dropped-option warning. 27 new tests; full suite/typecheck/lint/build green. |
| 2026-08-04 | Follow-up: `mute()`/`unmute()` now act on every active source (previously `activeStream` only), including sources added while muted; `dynamicSources` forwarded through the compat `useAudioCapture` prop list. 9 new tests (5 mute, 4 compat); full suite (235 files / 3887 tests), typecheck, and build green; lint unchanged at 0 errors / 3 pre-existing warnings. Both items moved out of "Known limitations" into the Implementation Summary. |
| 2026-08-04 | Cross-reference: the reference app's stale start-order comment (Current State Evaluation, above) was corrected in TASK-611, which also fixed a latent metadata-timeline-anchor defect on the capture-first path that the flip exposed. |
| 2026-08-05 | Cross-reference: TASK-612 hardened the surfaces this ticket introduced — the dropped-options warn is now ALSO a rejected promise (`CAPTURE_OPTIONS_DROPPED`), injected streams are validated (`SOURCE_STREAM_NOT_LIVE`) and are no longer stopped by SDK teardown (caller-owned, `AudioMixer.stopTracksOnRemove`), and a silent-uplink watchdog surfaces zero-signal streaming sessions. See `docs/implementation/TASK-612-Vox-External-Mic-Streams/`. |
