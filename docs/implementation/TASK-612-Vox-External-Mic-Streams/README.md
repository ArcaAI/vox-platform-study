# TASK-612 — External-microphone / injected-MediaStream support hardening (SDK v2 + compat)

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix + hardening (SDK, room, docs, e2e) |
| Branch | `dev-2.1` |
| Packages | `@arcaai/vox` (`packages/agentic-sdk-v2`), `@arcaai/room` (`packages/room`), `@arcaai/stt` (`packages/stt`), `apps/compat-playground` (e2e only) |
| Related | TASK-597 (source selection / `sourceStreams` seam), TASK-608 (browser-DSP switches), TASK-609 (runtime sources + dropped-options warn), TASK-611 (compat start order), TASK-560/564 (compat contract, `sendAudioData` metadata sink) |
| Execution model | Team of agents, one lane per agent — model tier + effort per lane (§Plan) |

## Requirement Analysis

External integrators build apps on `@arcaai/vox` (native and `/compat`) against the
HOPE v2 backend. Their UIs let the end user pick the audio source for live
transcription — one external microphone or several (single stream or multiple
streams). They pass the selected `MediaStream`(s) to our live-transcription hook
and observe **empty data on the STT WebSocket** (no signal, no transcripts). The
same application flow works on SDK v1.

Root-cause analysis (2026-08-05, full detail in §Current State) found no single
defect but an **audio-ownership inversion between v1 and v2** plus a set of
silent-failure paths around v2's one external-stream seam
(`AudioStartOptions.sourceStreams`). v1 apps captured audio themselves and pushed
PCM via `sendAudioData()`; any source worked by construction. v2 owns
capture end-to-end, and every failure around the injection seam today is
**silent**: wrong-mic capture, a dead reused stream, a silent source, or dropped
options all produce a structurally valid session whose uplink carries zeros — or
no session at all — with at most a `logger.warn` as evidence.

This ticket makes external-stream integration **fail loudly, behave predictably,
and be diagnosable**:

1. Injected streams are validated at start — a dead or trackless stream is a
   named error, not a silent zero uplink (AC-1).
2. Caller-owned streams are no longer killed by SDK teardown — stream reuse
   across sessions works, or fails with a named error, per OD-1 (AC-2).
3. Capture-shaped options dropped by the start race surface as an error on the
   calling hook, not only as a logger warning (AC-3).
4. A sustained silent uplink is detected and surfaced while the session runs
   (AC-4).
5. Compat integrators can see uplink/drop diagnostics without reaching into the
   v2 store (AC-5).
6. Whitespace-only finals stop polluting transcripts, context, and the compat
   `onTranscript` callback (AC-6, per OD-3).
7. The compat reference documents the external-source contract completely
   (capture-first order, ownership, `dynamicSources`, `audioProcessing`,
   `sendAudioData` = metadata sink, differential diagnosis) (AC-7).
8. An e2e regression suite locks all of the above using synthetic external mics
   (AC-8).

Non-goal: changing the v1-compat *API shapes*. Every change is additive or
error-surfacing; frozen v1 signatures stay frozen.

## Current State Evaluation (verified findings, 2026-08-05)

### The v1 ↔ v2 ownership inversion (why "it works on v1")

| Dimension | v1 (`@arcaai/agentic-sdk`) | v2 (`@arcaai/vox`) |
|---|---|---|
| Audio input API | `sendAudioData(ArrayBuffer, metadata?)` — app pushes PCM | SDK-owned capture; only seam is `AudioStartOptions.sourceStreams` (`types/audio.ts:345`) |
| `startTranscription()` | Zero args; opens socket only, never touches hardware | Compat: calls `audio.start({language, pipelineId})` → `getUserMedia({audio:true})` = **OS default mic** (`useArcaAudio.ts:392-393`) |
| Accepts MediaStream / deviceId? | Neither, anywhere in the public API | `sourceStreams` / `deviceId` / `secondaryDeviceId` / `additionalDeviceIds`, honored only by the first `audio.start()` |
| Capture ownership | App end-to-end (own gUM, own graph, own PCM16) | SDK end-to-end (48 kHz singleton context, worklet, resample to 16 kHz) |
| Multi-mic | App-side mixing + per-chunk `{device_id, role}` metadata | SDK `AudioMixer` (N > 1 sources, or `dynamicSources: true`) |
| Wire format | Binary `[type:1][metaLen:u32 BE][metaJSON][PCM16 LE]` at negotiated native rate | Raw binary Int16 LE 16 kHz mono, 2560-byte/80 ms frames; JSON `{type:'audio'}` frame is dead code (`SttWebSocketClient.ts:430-457`) |

### Root causes, ranked

| # | Cause | Mechanism | Evidence |
|---|---|---|---|
| RC-1 | v1-style integration against compat | `sendAudioData` is a **metadata sink** — PCM param is `_audioData`, never read; meanwhile `startTranscription()` opens default-mic capture. Integrator's audio is discarded; socket carries the wrong device (usually silence). `onAudioData` is likewise never invoked. | `compat/useArcaSpeechToText.ts:284-296`, `:253-258`; `compat/useAudioCapture.ts:15,118-119`; `useArcaAudio.ts:392-393` |
| RC-2 | Start-race drops source options | Capture-shaped options (`sourceStreams`, `deviceId`, `sourceGains`, `audioProcessing`, `dynamicSources`) are honored only by whichever `audio.start()` runs first; a second call drops them with **only** `logger.warn('…capture-shaped options were DROPPED')`. No store fallback exists for streams (deliberate). Our own `apps/quick-compat-app` had this bug (STT-first) until TASK-611. | `useArcaAudio.ts:224-253`; `compat/useAudioCapture.ts:39-58,189`; `docs/Compat-API-Reference.md:222` |
| RC-3 | SDK stops caller-owned tracks | `stopAudio` and failed starts stop **every** track in `sourceStreamsRef`, injected or not; `AudioMixer.removeSource`/`dispose` likewise. Documented (`types/audio.ts:343`) but violates integrator ownership intuition. A reused stream in the next session has `ended` tracks → silent uplink → "empty data". No liveness/track-count validation at start (truthiness filter only; unguarded `getAudioTracks()[0]`). | `useArcaAudio.ts:763-765, 1084-1098, 342, 473`; `packages/room/src/core/AudioMixer.ts:119-126, 322-331` |
| RC-4 | Structurally valid all-zero frames | (a) Caller-built stream from their own suspended `AudioContext` (`MediaStreamAudioDestinationNode`) is live-but-silent — nothing resumes a *caller's* context; (b) browser APM (echoCancellation/NS/AGC, on by default) can emit pure silence on virtual/loopback devices on the deviceId path — TASK-608's `audioProcessing` exists for this and is **ignored** for `sourceStreams`. | `apps/compat-playground/src/lib/file-audio-source.ts:111,183-201`; `types/audio.ts:357-376` |
| RC-5 | No transport at all | Falsy `pipelineId` (or missing `apiClient`) → `buildStreamingTransport` returns `undefined` → capture "works", `isRecording` true, socket never opens. Local STT is disabled platform-wide (TASK-545). Precision (Lane 0, verified 2026-08-05 after a Lane H flag): the SILENT variant occurs because without `sttPipelineId` the compat adapter never enables the STT stage (`config-adapter.ts:62` sets `stt.enabled: true` only with a pipeline id; `PluginManager` defaults `stt.enabled ?? false`), so no stage is constructed and nothing throws; an ENABLED stage with no transport throws `LOCAL_TRANSCRIPTION_DISABLED` loudly instead — both behaviors exist, on different config paths. | `PluginManager.ts:780-788`; `TranscriptionPipeline.ts:173-175, 703-706`; `config-adapter.ts:62` |

### Inbound-side findings

| # | Finding | Evidence |
|---|---|---|
| I-1 | Empty-string finals pass every guard end-to-end; compat delivers `onTranscript("0 : ", true, …)` with the default template (no `.trim()` on the chain) | `SttWebSocketClient.ts:880-885` → `useArcaAudio.ts:546-561` → `compat/useArcaSpeechToText.ts:221-234`; `speechToTextMetadata.ts:130-136` |
| I-2 | `lastInterimRef` never reset in `stopTranscription` — an identical first interim in the next session is swallowed | `compat/useArcaSpeechToText.ts:218, 269-282` |
| I-3 | Backpressure audio loss (`markAudioLost`, `droppedFrameCount`) is store-only — invisible to every compat hook | `useArcaAudio.ts:641-644`; no compat surface |
| I-4 | Latent: a zero-length resample output would reach `ws.send` unguarded (unreachable today; live the moment a flush path gains a caller) | `StreamingBackendSTTProvider.ts:292-303`; `audioResampler.ts:235-237` |

### Ruled out

- VAD gating: `useVadGate = runtimeProvider === 'local' && vad.enabled` — never active on the backend-streaming path (`TranscriptionPipeline.ts:168`).
- Mute: `track.enabled = false` yields full-length silence, not empty frames (`useArcaAudio.ts:1256-1275`).
- Worklet/port emit empty frames: guarded (`stt-capture.worklet.ts:104`; `audioCapture.ts:124`).

### Diagnosis differentials (becomes doc content in Lane H)

| Observable | Cause |
|---|---|
| Binary frames flowing, payloads all zeros, no/empty transcripts | RC-1 / RC-2 / RC-4 |
| No binary frames; only JSON `ready`/`status` | RC-3 (check `track.readyState === 'ended'`) |
| No socket at all | RC-5 (check `store.activePipeline`) |
| Log `capture-shaped options were DROPPED` | RC-2, definitively |
| Log `Using caller-supplied source streams` absent | streams never entered capture |
| `sourceLevels` stays `[0]`, `uplinkBitrate` > 0, no transcripts | silence is being sent (RC-4) |

## Implementation Plan

### Execution model — team of agents

One lane = one agent brief, dispatched per the tier table below (owner-supplied):

| Task complexity | Suggested tier | Effort level |
|---|---|---|
| Trivial / simple | haiku-4-5 | default |
| Moderate | sonnet-5 | medium |
| Complex | sonnet-5 or opus-4-8 | medium–xhigh |
| Very high complexity | opus-5 or fable-5 | medium–xhigh |

| Lane | Scope | Complexity | Tier / effort | Depends on |
|---|---|---|---|---|
| 0 | Design ratification + program review | Very high | fable-5 (opus-5 alt) / medium | — |
| A | Injected-stream liveness validation | Complex (contained) | sonnet-5 / high | 0 (OD-1 direction) |
| B | Caller-owned track lifecycle (ownership) | Complex (cross-package) | opus-4-8 / xhigh | 0 (OD-1), after A lands |
| C | Start-race dropped options → surfaced error | Moderate | sonnet-5 / medium | 0 (OD-2), after A lands |
| D | Silent-uplink watchdog | Moderate–Complex | sonnet-5 / high | — |
| E | Compat diagnostics parity | Moderate | sonnet-5 / medium | — |
| F | Empty-final hygiene + interim-ref reset | Moderate | sonnet-5 / medium | 0 (OD-3) |
| G | Trivial guards (zero-length frame) + changelog | Trivial | haiku-4-5 / default | — |
| H | Compat docs: external-source guide + reference gaps | Moderate | sonnet-5 / medium | A, B, C, D merged |
| I | E2E regression suite (synthetic external mics) | Complex | opus-4-8 / xhigh | A, B, C, D merged |

Parallelization: after Lane 0 ratifies OD-1/2/3, lanes {A → C → B} run sequentially
(all three edit `useArcaAudio.ts` — sequence minimizes conflicts), while D, E, F,
G run in parallel. H and I close the ticket. Lane 0 re-reviews the combined diff
before Phase 5.

### Lane 0 — Design ratification + program review

Ratify the three open decisions (recommendations below), review Lane B's design
note before it codes, and run the final integration review of the combined diff.
Deliverable: OD answers recorded in this README + review notes.

### Lane A — Injected-stream liveness validation (AC-1)

Fail loudly instead of streaming zeros:

- `useArcaAudio.startAudio` (`useArcaAudio.ts:342-352`): for each injected
  stream, require ≥ 1 audio track and ≥ 1 track with `readyState === 'live'`;
  otherwise throw a named error (`AgenticError('SOURCE_STREAM_NOT_LIVE')`,
  message naming the offending index/indices) *before* any teardown-sensitive
  state is registered.
- Guard `stream.getAudioTracks()[0]` (`:473`) — a trackless first stream is the
  same named error, never an undefined deref or a silent no-op.
- Same validation in runtime `addSource({stream})` (`:811-831`).

TDD (RED first): dead-stream start throws named error; trackless stream throws;
live stream passes unchanged; mixed live+dead throws listing dead indices;
`addSource` with dead stream rejects; failed validation leaves no open mics and
no armed timers (reuse the existing failed-start teardown assertions).

### Lane B — Caller-owned track lifecycle (AC-2, OD-1)

Stop killing streams the SDK does not own. Recommended design (OD-1a): tag
ownership at ingestion — `sourceStreamsRef` entries become
`{ stream, owned: boolean }` (gUM ⇒ `owned: true`, injected ⇒ `owned: false`);
teardown (`useArcaAudio.ts:763-765`, `:1084-1098`) stops only owned tracks and
disconnects nodes for all. `AudioMixer` gains a per-source
`stopTracksOnRemove` (default `true` — current behavior) so
`removeSource`/`dispose` (`AudioMixer.ts:119-126, 322-331`) respect ownership;
`useArcaAudio` passes `false` for injected sources.

Contract updates: `types/audio.ts:343` ("Every injected stream is stopped on
`stop()` exactly like an acquired one" — replaced by the ownership rule),
`docs/Compat-API-Reference.md`, room README. The asserted release-exactly-once
contract (`useArca.audio-unification.test.ts`) is revisited deliberately, not
patched around.

TDD: injected stream survives `stop()` (tracks stay `live`) and works on a
second `start()`; gUM streams still released exactly once (recording indicator
contract); mixer `removeSource` on an injected source keeps its tracks live;
`dispose()` mixed-ownership session stops only owned tracks; failed-start path
honors ownership too.

### Lane C — Start-race dropped options become surfaced errors (AC-3, OD-2)

In the call-time idempotence guard (`useArcaAudio.ts:224-253`): when the ignored
call carries capture-shaped options, **reject** (recommended OD-2a) with a named
error (`AgenticError('CAPTURE_OPTIONS_DROPPED')` listing the dropped keys) so
`useAudioCapture.startRecording`'s existing catch → `setError` + `onError`
surfaces it. The coordinated dual-hook path (second start with only
language/pipeline) keeps today's silent info return — that path is the designed
idempotence, not a mistake. Keep the existing warn for log-based triage.

TDD: STT-first then capture-with-`sourceStreams` → rejection with named error +
`onError` fired; capture-first then plain `startTranscription()` → no error
(info path unchanged); double `startRecording()` with identical sources →
guarded by the render-time `isCapturing` return before the throw path (verify —
if a stale snapshot reaches the guard, the error names the keys, which is
correct behavior, but assert the common re-render case stays quiet).

### Lane D — Silent-uplink watchdog (AC-4)

The session-level meter already computes RMS every 100 ms
(`useArcaAudio.ts:435-465`). Add a one-shot detector: capturing + streaming
transport active + level 0 (and all `sourceLevels` 0 when present) continuously
for N seconds (default 5, constant) → set a store signal
(`audioSignalState: 'ok' | 'silent'`), emit `logger.warn`, and surface through
compat `onStatus('no_audio_signal')` (additive on the existing optional prop,
mirroring the TASK-568 reconnect events). Clears on first non-zero level.

TDD (fake timers): 5 s of zeros → one event + state flip; recovery clears;
non-streaming (no pipeline) session never fires; no repeat spam while silent.

### Lane E — Compat diagnostics parity (AC-5)

Expose on `useAudioCapture`'s return (additive fields, no signature breaks):
`uplinkBitrate` (store `audioUplinkBitrate`), `audioLost`
(`audioLostThisSession`), `droppedFrames` (`audioDroppedFrameCount`). Document
in the compat reference (Lane H owns the prose). TDD: fields track store writes;
absent store values degrade to `0`/`false`.

### Lane F — Empty-final hygiene + interim reset (AC-6, OD-3)

- Whitespace-only final (`result.text.trim() === ''`): skip
  `addTranscriptSegment` and the context POST (`useArcaAudio.ts:546-591`),
  debug-log the suppression (recommended OD-3a). Interim `''` already
  suppresses.
- Compat: with suppression upstream, `onTranscript` never renders `"0 : "` from
  an empty final — add the regression test at the compat layer anyway.
- Fix I-2: reset `lastInterimRef` in `stopTranscription`
  (`compat/useArcaSpeechToText.ts:269-282`).

TDD: empty/whitespace final → no segment, no POST, no callback; normal finals
unchanged; same first interim across two sessions fires both times.

### Lane G — Trivial guards + changelog (haiku tier)

- `StreamingBackendSTTProvider.processAudio` (`:296-303`): skip send when the
  resampled Int16 view is empty (closes latent I-4) + unit test.
- CHANGELOG entries for every lane; cross-link this README from the TASK-597/609
  READMEs' follow-up sections.

### Lane H — Compat documentation (AC-7)

`docs/Compat-API-Reference.md` + `MIGRATION_GUIDE.md` + SDK README:

- Document `dynamicSources` and `audioProcessing` on `useAudioCapture`
  (implemented in TASK-608/609, currently absent from the reference — verified
  gap).
- New section "External microphones & injected streams": the capture-first rule
  (with the RC-2 failure mode), ownership semantics as landed by Lane B,
  fresh-streams vs reuse, `sendAudioData` = metadata sink (RC-1 callout, with
  the `onAudioData`-never-fires warning), APM/virtual-device guidance
  (`audioProcessing` — and that it is ignored for `sourceStreams`), pipelineId
  requirement, all-hooks-from-`/compat` bundle rule.
- The §Diagnosis-differentials table above, verbatim, as a troubleshooting
  matrix.

Gate: every claim carries a file reference or a landed-lane behavior; no
aspirational docs.

### Lane I — E2E regression suite (AC-8)

Playwright against the compat playground (or SDK e2e project), using file-backed
`MediaStreamAudioDestinationNode` streams as synthetic external mics (the
playground's `file-audio-source.ts` pattern):

1. Injected single stream, capture-first → non-zero uplink, transcripts arrive.
2. Injected multi-stream (mixer path) → transcripts arrive; `sourceLevels`
   length matches.
3. Stream reuse after `stop()` → per OD-1: works (Lane B) — assert tracks still
   `live`.
4. Dead stream at start → named `SOURCE_STREAM_NOT_LIVE` error (Lane A).
5. STT-first with `sourceStreams` → `CAPTURE_OPTIONS_DROPPED` surfaced (Lane C).
6. Silent live stream → `no_audio_signal` within the watchdog window (Lane D).

### Open decisions (owner) — block their lanes only

| OD | Question | Recommendation |
|---|---|---|
| OD-1 | Ownership semantics for injected streams | (a) **Never stop caller-owned tracks** (ownership flag; matches integrator intuition and v1 mental model). Alternative (b) clone-at-ingest keeps teardown untouched but breaks caller-side `track.enabled` mute and survives caller `stop()` — both surprising. (c) status-quo + docs only fixes nothing. |
| OD-2 | Dropped capture options: reject vs error-state only | **Reject the promise** — the only reason a second start carries sources is a bug; the dual-hook idempotent path is unaffected because it carries none. |
| OD-3 | Whitespace-only finals | **Suppress** (no segment, no context POST, no callback) — they carry no clinical value; suppression is logged. |
| OD-4 | Expose runtime `addSource`/`removeSource` on `/compat` (currently unreachable — stop/start is the only source-change path for compat apps) | Out of scope here; ticket separately if integrators need mid-session source changes. |

**Ratified 2026-08-05 (owner approved the plan as written, adopting the
recommendations):** OD-1 → (a) ownership flag — caller-owned tracks are never
stopped by SDK teardown; OD-2 → (a) reject the promise with a named error;
OD-3 → (a) suppress whitespace-only finals; OD-4 → deferred to a follow-up
ticket.

### Out of scope (recorded, not forgotten)

- `config-adapter.ts` REPLACE-not-MERGE audio config (P4 finding) — behavior
  change too broad for this ticket.
- `getDeviceStatus().selectedDevice` hardcoded to `inputDevices[0]`.
- Local (in-browser) STT path — disabled platform-wide (TASK-545).
- v1 gateway/service wire compat — untouched.

### Verification gates (Phase 5, per rule 08)

- `pnpm --filter @arcaai/vox build test lint typecheck` green (root: `pnpm sdk:build`)
- `pnpm --filter @arcaai/room build test` green; `pnpm --filter @arcaai/stt test` green
- SDK e2e: `pnpm --filter @arcaai/vox test:e2e` including the new Lane I specs
- No new lint warnings in `packages/*` (only-warn treated as errors)
- Evidence (actual command output) pasted into §Implementation Summary per lane

## Implementation Summary

_Populated per lane as work lands (evidence returned by each lane agent,
consolidated by Lane 0)._

### Lane I — e2e regression suite (DONE, opus tier)

Files added (nothing else touched):
- `packages/agentic-sdk-v2/e2e/task612-external-streams.e2e.spec.ts` — 6 specs;
  `beforeAll` esbuild-bundles its own harness (esbuild already present via tsup).
- `packages/agentic-sdk-v2/e2e/fixtures/task612-harness.tsx` — React harness
  exposing `window.__T612`; real `useArcaAudio` under a real
  `createAgenticStore()`.
- `packages/agentic-sdk-v2/e2e/fixtures/task612.html` — self-contained page
  (no CDN, no import map; built bundle path is gitignored).

Real in these tests: the WebAudio graph, `MediaStream`/`MediaStreamTrack.
readyState`, `@arcaai/room`'s `AudioContextManager` + `AudioMixer` (fresh dist,
`stopTracksOnRemove` present), the Zustand store, the level meter. Doubled:
ONLY `PluginManager` (STT/VAD/noise-filter need ONNX/WASM + a gateway; no
TASK-612 contract depends on them). Sources are `MediaStreamAudioDestination-
Node`s fed by an oscillator (signal) or `ConstantSourceNode(0)` (silence) —
no physical device needed (test 4 alone uses the Playwright fake device for
its realistic default-mic first start).

All six scenarios RAN GREEN in real Chromium (`pnpm --filter @arcaai/vox
test:e2e:chromium task612`, `6 passed (15.4s)`, 6 consecutive green runs incl.
2 cold-start): (1) injected tone captures — level 87, `sourceLevels [87]`,
signal `'ok'`; (2) OD-1a reuse — tracks `'live'` after stop, second start
succeeds; (3) dead stream refused by name (`SOURCE_STREAM_NOT_LIVE`,
`sourceStreams[0]`, initialize never called); (4) start race —
`CAPTURE_OPTIONS_DROPPED` + warn, running session untouched; (5) silent
stream → `audioSignalState 'silent'` at a measured **5002 ms**, clears on
stop; (6) two streams → mixer, per-source levels both non-zero, both caller
streams `'live'` after `stop()` (real `AudioMixer.dispose` honoring
ownership). Anti-vacuity: the tests are each other's controls (3 proves
`'ended'` is reportable so 2's `'live'` is meaningful; 1 proves `'ok'` so 5's
`'silent'` discriminates). One genuine flake (test 6 read mixer levels before
the first analyser tick) was root-caused and fixed by polling values, not
length. Deliberately NOT asserted (stated in the spec header): uplink bitrate
and arriving transcripts — they need the live gateway stack this Playwright
project has never had a fixture for; a gated test that cannot pass even with
the gateway up was judged worse than none.

Pre-existing finding (reported, not fixed — separate task chip filed): the
package's ORIGINAL e2e fixture (`e2e/fixtures/index.html` + `e2e-bundle.mjs`)
is broken at HEAD — the bundle keeps `react` and 7 other deps as bare
specifiers with no import map, so `window.SDK` never defines and all 38
legacy e2e tests fail in `beforeEach`; only Chromium is installed locally, so
the 3-project `test:e2e` cannot pass here regardless. Unrelated to TASK-612.

### Final verification (Lane 0, 2026-08-05)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/vox test` | **245 files / 3934 tests, 0 failures** |
| `pnpm --filter @arcaai/vox typecheck` | clean |
| `pnpm --filter @arcaai/vox lint` | 0 errors, 3 pre-existing warnings (untouched files) |
| `pnpm --filter @arcaai/vox build` | clean (run by `test:e2e` pre-step; tsup + dts success) |
| `pnpm --filter @arcaai/room test` / `typecheck` / `build` | 21 files / 514 tests; clean; DTS success |
| `pnpm --filter @arcaai/stt test` / `typecheck` | 26 files / 440 tests; clean |
| `pnpm --filter @arcaai/vox test:e2e:chromium task612` | 6/6 green, ×6 runs |

Net new TASK-612 tests: 13 unit/integration files (~80 tests across vox +
room + stt) + 6 e2e specs. Acceptance criteria AC-1…AC-8: all met (AC-8's
transcript-arrival assertion consciously scoped out as above).

### Lane H — compat documentation (DONE, sonnet tier)

Files changed:
- `packages/agentic-sdk-v2/docs/Compat-API-Reference.md` (+193/−7) — the
  `dynamicSources`/`audioProcessing` doc gap closed; Lane E diagnostics fields
  documented; `onStatus` gains `no_audio_signal`/`audio_signal_restored`; new
  §8 "External microphones & injected streams" (start order + rejection,
  ownership, liveness, `sendAudioData` trap, virtual-device DSP guidance,
  `pipelineId` requirement, watchdog, compat-import rule, troubleshooting
  table updated to post-fix reality, coarse-`ErrorInfo.code` note); trailing
  sections renumbered (anchor-grep verified safe).
- `docs/implementation/TASK-560-…/MIGRATION_GUIDE.md` (+41) — "External
  microphones / custom audio sources (TASK-612)" section with a before/after.
- `packages/agentic-sdk-v2/README.md` (+1) — pointer line.
- `packages/agentic-sdk-v2/CHANGELOG.md` (+45) — TASK-612 block under
  Unreleased, ownership change explicitly flagged as a behavior change.

Every documented claim was verified against the landed source (checklist in
the lane report). Lane H findings, resolved by Lane 0:
1. The TASK-597/609 cross-links Lane 0 had taken over from Lane G's plan were
   confirmed missing — now added to both tickets' Change History (2026-08-05).
2. RC-5 "silent vs throws" tension — verified in code and clarified in the
   RC-5 row above (silent = STT stage never enabled; enabled-but-transportless
   throws `LOCAL_TRANSCRIPTION_DISABLED`).
3. The reference documents the start-race rejection for the verified ordering
   only (a stale render-time `isCapturing` snapshot can still short-circuit
   before the throw) — deliberate wording, accepted.

### Lane A — injected-stream liveness validation (DONE, sonnet tier)

Files changed:
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` (+65) — module-scope helper
  `injectedStreamLivenessViolation(stream)` (`'no audio track' | 'no live audio
  track' | null`); aggregate validation in `startAudio` immediately after
  `injectedStreams` is computed and BEFORE `sourceStreamsRef` registration —
  throws `AgenticError('SOURCE_STREAM_NOT_LIVE')` naming every offending
  `sourceStreams[i]` and reason; defensive guard on the previously-unguarded
  `stream.getAudioTracks()[0]`; same validation on `addSource({stream})` before
  any registry/mixer mutation.
- `packages/agentic-sdk-v2/src/types/common.ts` (+5) — `'SOURCE_STREAM_NOT_LIVE'`
  added to the `AgenticErrorCode` union.
- New `packages/agentic-sdk-v2/src/hooks/__tests__/task612-source-stream-validation.test.ts`
  (390 lines, 8 tests; harness reused from the task609/task597 test files).

Evidence:
- RED: 7 of 8 failed pre-fix (`promise resolved "undefined" instead of
  rejecting`, `resolved "'source-2'"` on addSource). Test (g) proved the pre-fix
  bug concretely: a trackless stream made `start()` RESOLVE — `pluginManager.
  initialize(undefined, …)`, `isCapturing: true`, no error — the literal RC-3
  "structurally valid session, silent zero uplink".
- GREEN: 8/8; FULL `@arcaai/vox` suite 238 files / 3906 tests, 0 regressions;
  typecheck clean; lint 0 errors (3 pre-existing warnings in untouched files).
- Validation throws before registration, so the failed-start teardown iterates
  an empty list — caller tracks provably untouched (test f). Composes cleanly
  with Lane B; `types/audio.ts` ownership contract deliberately left to Lane B.
- Error message format: `sourceStreams[N]: <reason>` — grep-able by the caller.

### Lane B — caller-owned track lifecycle (DONE, opus tier + Lane 0 completion)

Execution note: the opus agent completed the `@arcaai/room` half (mixer flag +
8 ownership tests, verified green) but was lost to two transport-level failures
(stream-watchdog stall, then a connection-closed API error on resume). Lane 0
verified its landed work from the tree and completed the vox half directly.

Design choice (recorded): ownership is a **WeakSet companion**
(`callerOwnedStreamsRef`) to `sourceStreamsRef`, NOT a reshape of the array —
every existing reader (teardown loops, mute walk, positional `sourceGains` /
`sourceIds` alignment) keeps operating on plain `MediaStream`s; the set is
identity-only, reassigned fresh per `startAudio`, and cannot retain a stream
the session forgot.

Files changed:
- `packages/room/src/core/AudioMixer.ts` (+ core/root barrels) —
  `AudioMixerAddSourceOptions.stopTracksOnRemove` (default `true` = pre-612
  behavior), stored per source; `removeSource` stops tracks only when set;
  `dispose()` delegates to `removeSource` so the two cannot drift. New
  `packages/room/src/__tests__/AudioMixer.ownership.task612.test.ts` (8 tests).
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — `callerOwnedStreamsRef`
  + fresh ownership snapshot at registration; failed-start loop, stopAudio
  loop, and the previously-unconditional `activeStream` stop block all skip
  caller-owned streams; startAudio mixer sources and runtime
  `addSource({stream})` register `stopTracksOnRemove: false`
  (`{deviceId}` ⇒ `true`); REF CONTRACT / removeSource / dispose comments
  updated so no comment states the old behavior.
- `packages/agentic-sdk-v2/src/types/audio.ts` — `sourceStreams` JSDoc: the
  "stopped on stop() exactly like an acquired one" sentence replaced with the
  OD-1a ownership contract + the Lane A liveness requirement.
- New `src/hooks/__tests__/task612-caller-owned-streams.test.ts` (7 tests).

Evidence:
- RED: 5/7 failed pre-fix; test (2) reproduced RC-3 verbatim — the second
  `start()` with the same stream rejected `SOURCE_STREAM_NOT_LIVE …
  sourceStreams[0]: no live audio track` because `stop()` had ended the
  caller's track.
- GREEN: 7/7; room ownership tests 8/8.
- Invariant held: `useArca.audio-unification.test.ts` ("microphone released
  EXACTLY once", gUM path) passed **unchanged**.
- Deliberate assertion updates (3, each commented): Lane A's addSource
  assertion + two in `useArcaAudio.dynamicSources.task609.test.ts` — all
  encoded the pre-B three-arg `mixer.addSource` signature; updated to assert
  the ownership arg (`true` for deviceId, `false` for caller streams).
- Full verification: room build (DTS success) → room 21 files / 514 tests,
  tsc clean; vox 241 files / 3919 tests, tsc clean, lint 0 errors
  (3 pre-existing warnings).

### Lane C — start-race dropped options reject (DONE, sonnet tier + Lane 0 ruling)

Files changed:
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — the call-time idempotence
  guard now keeps the `logger.warn` and ALSO throws
  `AgenticError('CAPTURE_OPTIONS_DROPPED', <dropped keys + remediation>)` when
  the ignored start carried capture-shaped options; the coordinated dual-hook
  path (no capture options) keeps `logger.info` + silent return. Guard comment
  updated to the new contract.
- `packages/agentic-sdk-v2/src/types/common.ts` — `'CAPTURE_OPTIONS_DROPPED'`
  added to `AgenticErrorCode`.
- New `src/hooks/__tests__/task612-dropped-options.test.ts` (4 tests) and
  `src/compat/__tests__/task612-dropped-options.compat.test.ts` (2 tests).

Evidence:
- RED: (a)/(b) failed pre-fix — `start()` resolved instead of rejecting (the
  RC-2 bug); (c)/(d) assert unchanged behavior and passed pre-fix by design.
- GREEN: 4/4 + 2/2; Lane A's 8/8 re-run clean after the shared-file edit;
  typecheck clean; lint 0 errors (same 3 pre-existing warnings).
- Known limitation (for Lane H to document): compat `toErrorInfo()` hardcodes
  `ErrorInfo.code = 'AUDIO_CAPTURE_ERROR'`; the `CAPTURE_OPTIONS_DROPPED`
  specificity travels in the message, not the compat code field.

**Lane 0 ruling — deliberate contract-test update:** the full suite surfaced ONE
deterministic failure: `useArcaAudio.deviceLoss.task609.test.ts` asserted the
OLD contract ("second start with capture options WARNS and resolves") — the
literal RC-2 behavior OD-2a replaces. Lane 0 updated that single test to the
ratified contract (renamed `WARNS and REJECTS with CAPTURE_OPTIONS_DROPPED…`,
asserts the rejection AND the warn; comment records the TASK-612 change).
Verified: deviceLoss + task612 A/C files → 3 files / 16 tests green.

### Lane D — silent-uplink watchdog (DONE, Lane 0 after agent loss)

Execution note: the sonnet agent was lost to a connection-closed API error
(host machine slept mid-run) after finishing exploration and writing ONE
artifact — a complete, high-quality watchdog test file, which Lane 0 adopted
verbatim as the RED baseline and then implemented against directly.

Files changed:
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` —
  `audioSignalState: 'ok' | 'silent'` + `setAudioSignalState` (house setter
  pattern).
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — module constants
  `LEVEL_METER_INTERVAL_MS = 100` / `SILENT_UPLINK_WATCHDOG_MS = 5000`; the
  watchdog rides the EXISTING level-meter tick (no second timer): on a
  streaming session (`pipelineId` captured as a closure boolean at start),
  unmuted (live `isMutedRef` written by `muteAudio`/`unmuteAudio` — the timer
  closure's store snapshot goes stale, so mute needed an imperative channel),
  50 consecutive zero-level ticks ⇒ `setAudioSignalState('silent')` + ONE
  `logger.warn` naming the RC-4 causes; first non-zero tick ⇒ `'ok'` and the
  episode re-arms; mute resets the counter so unmute gets a fresh window.
  Signal reset to `'ok'` on start and stop. Watchdog is unavailable exactly
  where the meter is (documented in the meter comment).
- `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` — additive
  `onStatus('no_audio_signal')` / `onStatus('audio_signal_restored')` on
  store-signal transitions (same pattern as the TASK-568 reconnect events).
- Tests: `src/hooks/__tests__/task612-silent-uplink-watchdog.test.ts`
  (6 scenarios, incl. episode latch, recovery + re-arm, non-streaming/muted
  suppression, stop clears) and
  `src/compat/__tests__/task612-no-audio-signal.compat.test.ts` (2).

Evidence:
- RED: watchdog file 4 failed / 2 passed (the two "never fires" cases pass
  pre-fix by design); compat file 1 failed / 1 passed.
- GREEN: 8/8; FULL vox suite 243 files / 3927 tests, 0 failures; typecheck
  clean (one real TS error in the new compat test — untyped `vi.fn()` — was
  caught by the gate and fixed with a typed mock); lint 0 errors
  (3 pre-existing warnings). One transient single-test failure in an earlier
  full run did not reproduce on two clean re-runs (documented flake arbiter).

### Lane E — compat diagnostics parity (DONE, sonnet tier)

Files changed (additive only; frozen v1 members untouched):
- `packages/agentic-sdk-v2/src/compat/useAudioCapture.ts` — `UseAudioCaptureReturn`
  gains `uplinkBitrate: number`, `audioLost: boolean`, `droppedFrames: number`,
  each read via its own atomic `useAgenticStore` selector with `?? 0` / `?? false`
  degradation (mirrors the existing `sourceLevels ?? []` precedent).
- `packages/agentic-sdk-v2/src/compat/__tests__/useAudioCapture.test.ts` —
  harness extended; 3 new tests (reactive store binding, defaults when unset,
  return-shape superset over the frozen v1 keys).

Store bindings (verified in `agenticStore.ts` before coding):
`audioUplinkBitrate` → `uplinkBitrate`; `audioLostThisSession` → `audioLost`;
`audioDroppedFrameCount` → `droppedFrames`.

Evidence:
- RED: 3 failed / 12 passed — the 3 new tests (`expected undefined to be 128000`,
  `…to be +0`, `…to have property "uplinkBitrate"`); pre-existing tests green.
- GREEN: 15/15 in the file; FULL `@arcaai/vox` suite 237 files / 3898 tests,
  0 failures; `tsc --noEmit` clean; lint clean on the changed source file
  (`**/__tests__/**` is globally lint-ignored in this package, pre-existing).
- Ops note for later lanes: `pnpm --filter @arcaai/vox test -- <path>` does NOT
  scope to a file (runs the whole suite); use `pnpm exec vitest run <path>` from
  the package directory instead. One earlier full run showed 12 transient
  "forks worker" errors in 6 unrelated files that did not reproduce on the clean
  confirmatory run — recorded as pre-existing infra flakiness.

### Lane F — empty-final hygiene + interim reset (DONE, sonnet tier)

Files changed:
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — `onTranscription` final
  branch: whitespace-only finals are suppressed AFTER the interim is cleared —
  no `addTranscriptSegment`, no context POST, no NER trigger; one debug log
  (OD-3a).
- `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` — final-diff loop
  skips empty/whitespace finals (cursor still advances; belt-and-braces below
  the upstream suppression); `stopTranscription` now resets `lastInterimRef`
  (I-2: identical first interim of the next session was swallowed).
- New tests: `src/hooks/__tests__/task612-empty-final-hygiene.test.ts` (5) and
  `src/compat/__tests__/task612-empty-final-hygiene.compat.test.ts` (2).

Evidence:
- RED: hooks 2/5 failed (`addTranscriptSegment` called with `"   "` / `""`);
  compat 2/2 failed — case (1) literally produced `onTranscript("0 :    ",
  true, …)` (finding I-1 verbatim), case (2) the interim fired once not twice
  (I-2).
- GREEN: 7/7; FULL vox suite **245 files / 3934 tests, 0 failures** (baseline
  243/3927 + this lane); typecheck clean; lint 0 errors (3 pre-existing
  warnings). All 11 TASK-612 test files re-run together: 65 tests, 0 failures.

### Lane G — zero-length frame guard (DONE, haiku tier)

Files changed:
- `packages/stt/src/providers/StreamingBackendSTTProvider.ts` — `processAudio()`
  now returns early when the resampled Int16 view is empty (`int16.length === 0`),
  before any counters or the send ("Empty frames must never reach the wire").
- `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` —
  new test `skips sending empty frames after resampling (TASK-612 Lane G)`:
  1-sample Float32 input at 48 kHz ⇒ `sendAudioFrame` not called, drop count and
  bytesSent unchanged.

Evidence:
- RED: `AssertionError: expected "vi.fn()" to not be called at all, but actually
  been called 1 times — 1st call: [Int16Array []]` (empty frame reached the send
  before the guard).
- GREEN + full suite: `Test Files 26 passed (26) · Tests 440 passed (440)`;
  `pnpm --filter @arcaai/stt typecheck` clean.
- Changelog step skipped — `packages/stt` has no CHANGELOG.md (per brief, not
  created).

## Change History

| Date | Change |
|---|---|
| 2026-08-05 | Ticket created from the external-integrator empty-socket-data investigation: findings (RC-1…RC-5, I-1…I-4, ruled-out list), 10-lane agent execution plan with model-tier assignments, OD-1…OD-4 open decisions. Status Pending — awaiting plan approval + OD ratification. |
| 2026-08-05 | Owner approved the plan; OD-1a/OD-2a/OD-3a ratified, OD-4 deferred. Status → In Progress. Wave 1 dispatched: Lane A (sonnet), Lane E (sonnet), Lane G (haiku) in parallel — file-disjoint. Chain A → C → B → D → F serialized on `useArcaAudio.ts`; H + I after the chain. Lane evidence is returned to the orchestrator (Lane 0) and consolidated here serially to keep this README single-writer. |
| 2026-08-05 | All 10 lanes complete; status → **Review**. Execution notes: Lanes B (vox half) and D were completed by Lane 0 after the assigned agents were lost to host-sleep transport failures (their landed partial work — B's full room half, D's complete test file — was adopted, verified, and credited); 6 old test assertions across 3 files encoding pre-612 contracts were updated deliberately, each with a comment. Lane H's 3 audit findings resolved (cross-links added to TASK-597/609, RC-5 clarified in-place, start-race doc scoping accepted). Lane I found the package's LEGACY e2e fixture broken at HEAD (bare specifiers, all 38 legacy specs) — pre-existing, filed separately. Final gates green across vox/room/stt (matrix in §Final verification). Owner follow-ups: review + commit the working-tree changes; OD-4 (compat runtime add/removeSource) and the legacy e2e fixture remain open as separate items. |
| 2026-08-05 | **Integrator root cause confirmed in the consumer app** (ALaaS-v3 `apps/web_ui`, vox 2.0.3): the external-mic MediaStream never reaches the SDK — `ClinicalUIPopUp.jsx:783` passes `onStreamCreated` to `MultiMicAudioPlayer`, but the component neither declares that prop nor builds a MediaStream at all (no `createMediaStreamDestination`; its WebSocket WAV chunks go decode → BufferSource → gain → speakers only). `handleStart` therefore always takes the default-stream branch (SDK captures the silent default mic → all-zero frames = RC-1), while the real external-mic audio is pushed through `sendAudioData` (metadata sink, PCM discarded by design). The app's hook config itself is correct (`options.sttPipelineId \|\| 'default'`, top-level `sourceStreams`, capture-first MMR branch). Confirms the TASK-612 hardening (liveness validation + silent-uplink watchdog) targets the right seam; consumer-side remediation planned separately in the ALaaS-v3 repo. |
| 2026-08-05 | Release prep for **SDK 2.0.4**: changelog `[Unreleased]` folded into `[2.0.4] — 2026-08-05`; all 7 SDK packages lockstep-bumped 2.0.3 → 2.0.4; `pnpm sdk:build` + unit/typecheck/lint gates re-run (evidence in the release session). Publish to npm.pkg.github.com remains owner-executed per `docs/operations/vox-sdk-release/README.md`. |
