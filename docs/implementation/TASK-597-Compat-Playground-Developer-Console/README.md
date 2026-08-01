# TASK-597 — Compat Playground Developer Console

| Field | Value |
|---|---|
| **Status** | `Review` — all lanes complete, verified; see §7 |
| **Type** | `feature` (app + SDK + gateway), with one `bugfix` lane (stop latency) |
| **Ticket number** | **Confirmed free (lane G, 2026-08-01).** `docs/archive/` was readable this time and contains no `TASK-59*`; the highest number across `docs/implementation/` + `docs/archive/` is this ticket. |
| **Surfaces** | `apps/compat-playground`, `packages/agentic-sdk-v2` (`/compat` + core audio), `packages/room`, `apps/api` (`stt-compat`, `streaming`, `smr-compat`), `apps/stt` |
| **Date** | 2026-08-01 |

---

## 1. Requirement Analysis

The compat playground is the reference surface a v1→v2 migrating engineer reads before touching their own app. The request restructures it into a **developer console** with three isolated tabs and adds five live-transcription capabilities and three summarization capabilities.

### 1.1 Requirements as acceptance criteria

| # | Requirement | Class |
|---|---|---|
| **R1** | Three isolated tabs: Connection, Live transcription (gated on connection), Summarization (gated on connection) | UX restructure |
| **R2** | Per-tab example code at the **end of each page**, reflecting exactly what that tab implements | UX restructure |
| **R3** | Audio source selection: one mic · multiple mics (mixed to one stream, per the screenshot) · an audio file that can simulate either a single-mic or a multi-mic-mixed recording | **SDK capability gap** |
| **R4** | Start/stop that is realtime and reactive — the current stop has a significant delay | **Defect (multi-layer)** |
| **R5** | Send / simulate metadata while streaming from multiple mics (`{"mic":"1","speaker":"1"}` per the screenshot) | Partial — client-side only today |
| **R6** | Provide a reference transcript for WER/CER scoring | New (no TS implementation exists) |
| **R7** | Switch between the selected audio pipeline and the tenant default STT provider | **Already shipped** — needs relocation + a pipeline picker |
| **R8** | Summarization: select department, visit type, provide pre-summary context | **Already shipped** — needs relocation + one fix |
| **R9** | Summarization: use the live caption from the transcription tab + extra context | Partial — wiring breaks when tabs are split |
| **R10** | Summarization: toggle streaming vs non-streaming generation | SDK + gateway shipped; **UI not wired** |

### 1.2 Interpretation calls made (flag if wrong)

- **"Multiple microphones"** in the screenshot means *N* physical inputs mixed client-side into one uplink stream, with metadata frames marking which mic/speaker is active — matching the current `AudioMixer` model. We implement **N sources**, not just 2.
- **"Simulate a recording as multiple microphones"** means: the developer supplies one or more audio files (or one file plus a per-channel split), each file is mapped to a virtual mic, and the same mixer path produces one uplink stream plus mic-attributed metadata. Deterministic, repeatable — this is what makes R6 (WER/CER) meaningful.
- **"Reactive"** stop means the UI returns to idle and the mic light goes out **immediately**, while late-arriving tail finals still land in the transcript. It does *not* mean discarding the tail.

---

## 2. Current State Evaluation

Everything below was read in the working tree on 2026-08-01 (branch `dev-2.1`).

### 2.1 App — `apps/compat-playground` (~1.7k LOC, 9 components)

| File | Role | Verdict |
|---|---|---|
| [App.tsx](apps/compat-playground/src/App.tsx) | 2 tabs (`Playground`, `Example code`), 3-column grid, mounts `ArcaCompatProvider` on connect | Rewrite — becomes 3 tabs |
| [ConfigColumn.tsx](apps/compat-playground/src/components/ConfigColumn.tsx) | apiEndpoint / apiKey / tenantId / pipelineId, localStorage persistence, read-only when connected | Promote to the Connection tab; pipelineId becomes a picker |
| [SessionWorkspace.tsx](apps/compat-playground/src/components/SessionWorkspace.tsx) | Owns session + transcript state, wires `useArcaSessionManager` / `useAudioCapture` / `useArcaSpeechToText` | Split: state must **lift above the tabs** so R9 survives tab isolation |
| [ControllerColumn.tsx](apps/compat-playground/src/components/ControllerColumn.tsx) | Language picker, provider toggle, start/stop, metadata simulator | Becomes the Live-transcription tab controls |
| [TranscriptColumn.tsx](apps/compat-playground/src/components/TranscriptColumn.tsx) | Two-track timeline (text ‖ returned metadata) | Keep; add WER/CER diff view |
| [SummaryCard.tsx](apps/compat-playground/src/components/SummaryCard.tsx) (467 LOC) | Department picker, visit type, clinical context, pre-summary → summary, Enhanced/Simplified/SOAP renderers | Becomes the Summarization tab; **no streaming toggle** |
| [ExampleCode.tsx](apps/compat-playground/src/components/ExampleCode.tsx) | Loads 8 real source files via `import.meta.glob(?raw)` — genuinely the running source, not a paraphrase | Keep the mechanism, **re-scope per tab** |
| [lib/departments.ts](apps/compat-playground/src/lib/departments.ts) | `GET /api/v1/admin/departments` with `x-api-key`, defensive envelope unwrap | Keep; template for a pipelines fetch |

**Finding A1 — the example-code mechanism is the right one and must be preserved.** `import.meta.glob(…, {query:'?raw'})` reads from disk at runtime, so it can never drift. R2 only changes *scoping* (per tab, at page end) — do not replace it with hand-written snippets.

**Finding A2 — the summarization surface is already complete for R8**, including a real department fetch with graceful free-text fallback, both canonical visit types, and full clinical context fields. R8 is a *move*, not a build.

**Finding A3 — `SummaryCard` receives `transcriptLines` as a prop from `SessionWorkspace`.** Splitting the tabs breaks this unless session state is lifted to a provider-level context. This is the single highest-risk refactor in the ticket.

**Finding A4 — visit-type presets drifted from the README.** The code offers `New / Referral` and `Follow-up / Review` ([SummaryCard.tsx:47](apps/compat-playground/src/components/SummaryCard.tsx:47)); the README documents `New Patient / Revisit / Referral`. The seeded default state also sets `'New Patient'` — a value that is **not** in the preset list, so the select renders with no matching option on first paint.

**Finding A5 — no audio-source UI at all.** No device enumeration, no file input. `useAudioCapture.getDeviceStatus()` exists and enumerates devices, but nothing in the app calls it, and there is no way to pass a `deviceId` through the compat hook.

### 2.2 SDK compat — `packages/agentic-sdk-v2/src/compat` (~1.9k LOC + 2.2k LOC tests)

| Hook | Contract | Verdict |
|---|---|---|
| `useAudioCapture` | Wraps `useArcaAudio`; forwards only `{pipelineId, language, languageMode, startOn}` | **Blocks R3** — no `deviceId` / `secondaryDeviceId` / stream passthrough |
| `useArcaSpeechToText` | Synthesizes the v1 `onTranscript(text,isFinal,meta)` by diffing store selectors; `sendAudioData` is a **metadata sink** with a 256-entry capture-relative timeline | Sound. R5 extends it, does not rewrite it |
| `useArcaSttProvider` | Bidirectional pipeline ↔ tenant-default switch, pre-start selection via `pendingSttProvider` | **R7 already met** |
| `useSMR` | `summarize/summarizeSync/summarizeAsync/preSummarize`; `{stream:true, onDelta}` drives a full SSE reader | **R10 met at the SDK layer** — only the UI is missing |
| `useArcaSessionManager` | v1 session lifecycle over v2 consultations | Untouched |
| `config-adapter` | `V1SdkConfig` → `AgenticConfig`, normalizes `/api/v1`, rejects a missing apiKey | Untouched |

**Finding S1 (R3 blocker) — `useAudioCapture` drops device selection.** `AudioStartOptions` already carries `deviceId` and `secondaryDeviceId` ([types/audio.ts:290-299](packages/agentic-sdk-v2/src/types/audio.ts:290)), and `useArcaAudio.startAudio` honours both — including mixing via `@arcaai/room`'s `AudioMixer` ([useArcaAudio.ts:214-235](packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:214)). The compat hook simply never forwards them. **Cheapest real capability in the ticket.**

**Finding S2 (R3 blocker) — the mic ceiling is exactly 2.** `AudioMixer` is N-source with per-source gain (`addSource(id, stream, gain)`), but `useArcaAudio` wires precisely one `secondaryDeviceId`. Three or more mics needs an `AudioStartOptions.additionalDeviceIds?: string[]` (or a `sources[]` array) and a loop.

**Finding S3 (R3 blocker) — no way to inject a non-mic source.** `startAudio` calls `navigator.mediaDevices.getUserMedia` unconditionally. A file-backed source needs an injection seam — `AudioStartOptions.sourceStreams?: MediaStream[]` — so the app can build streams with `AudioBufferSourceNode → createMediaStreamDestination()` and feed the *identical* mixer → noise-filter → VAD → STT graph. Without this seam, file playback can only be faked by playing audio out of the speakers into the mic, which is useless for R6.

**Finding S4 (R5 limit) — metadata never reaches the wire on the v2 path.** `sendAudioData` records metadata **client-side only** and replays it onto the next synthesized `onTranscript` ([useArcaSpeechToText.ts:236-248](packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts:236)). The v2 gateway `/ws/stt/stream` accepts only `audio | stop | resume | close` and answers anything else with `UNKNOWN_TYPE` ([stt-ws.gateway.ts:884](apps/api/src/modules/streaming/stt-ws.gateway.ts:884)). Meanwhile the **v1 compat gateway `/stt` does accept per-frame metadata** (a 5-byte header + JSON prefix, `MAX_METADATA_BYTES = 8192`) and echoes it back on transcripts ([stt-compat.gateway.ts:175-200](apps/api/src/modules/stt-compat/stt-compat.gateway.ts:175)). So the screenshot's "metadata sent along with stream" is **real on the v1 wire and simulated on the v2 wire**. The playground uses the v2 wire. This asymmetry must be stated in the UI, not papered over.

**Finding S5 — the v1 gateway's metadata is also session-sticky, not per-frame-correlated.** `session.metadata = …` is last-wins ([stt-compat.gateway.ts:192](apps/api/src/modules/stt-compat/stt-compat.gateway.ts:192)), so even the "real" path attributes by recency, exactly like the client-side timeline. Honest framing: *both* paths are recency-attributed; only the transport differs.

### 2.3 Stop latency (R4) — root cause, traced end to end

The chain, in order:

1. `SessionWorkspace.stop()` awaits `stt.stopTranscription()` **before** `capture.stopRecording()` ([SessionWorkspace.tsx:122-127](apps/compat-playground/src/components/SessionWorkspace.tsx:122)).
2. `stopTranscription` → `audio.stop()` → `pluginManager.destroy()` → `TranscriptionPipeline.destroy()` → `StreamingBackendSTTProvider.destroy()`.
3. That provider awaits **`wsClient.stopAndDrain()`**, which sends `{type:'stop'}` and then blocks for a terminal `status: closed|cancelled` **or 5000 ms**, whichever comes first ([SttWebSocketClient.ts:464-506](packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts:464)).
4. The gateway turns `stop` into a `finalize` control command and only emits `status: closed` when the Redis result subscription **completes** ([stt-ws.gateway.ts:466-472](apps/api/src/modules/streaming/stt-ws.gateway.ts:466), [streamingAudioBridge.service.ts:487-492](packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:487)).
5. Python publishes `closed` only at the **very end** of `_finalize_session_locked`: after the tail-flush ASR inference, after draining the inference queue, after uploading the remaining raw PCM chunk + raw complete WAV + processed WAV + transcript + metadata to MinIO, after `_register_dual_capture`, and after `_persist_streaming_transcript` ([session_manager.py:3560-3580](apps/stt/src/stt/streaming/session_manager.py:3560)).

**Finding D1 — the delay is structural, not a bug in one place.** The client's 5 s drain is gated on a terminal status that the server deliberately publishes *after* durable persistence. On a slow MinIO or a long tail utterance the full 5 s burns every time.

**Finding D2 — the mic stays hot for the entire drain.** Because `audio.stop()` tears the transport down *before* stopping the `MediaStream` tracks ([useArcaAudio.ts stopAudio](packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts)), and because the app awaits STT first, the browser recording indicator stays lit and `isRecording` stays `true` for up to 5 s after the user clicks Stop. This is the visible symptom the request describes.

**Finding D3 — the fix has three independent, individually shippable parts:**
- **App/SDK (fast, safe):** stop the capture graph *first* (mic off, `isRecording` false, UI idle immediately), then let the drain finish in the background and keep appending tail finals. Turns a 5 s block into a ~0 ms perceived stop with a "finalizing…" affordance.
- **Server (medium):** publish a distinct **`finalizing`** status early (it already exists — [session_manager.py:2760](apps/stt/src/stt/streaming/session_manager.py:2760)) and publish **`closed` immediately after the last transcript is emitted**, moving MinIO uploads + transcript persistence after the status publish (they are already `try/except`-guarded and non-fatal). This is the real fix and it benefits every consumer, not just the playground.
- **SDK (small):** make `drainTimeoutMs` configurable and lower the default; today it is a hard-coded 5000.

> ⚠️ The server change touches the durable-transcript path. It must **not** reorder `session.close()` relative to capacity release, and `_persist_streaming_transcript` must stay in the finalize critical section. Scope it as "publish `closed` earlier", never "skip persistence".

### 2.4 Gateway (`apps/api`)

| Surface | State |
|---|---|
| `smr-compat` (`POST /api/smr/api/v1/summary/sync`, `/presummary`) | Stateless shim over SMR `/generate`; **both** routes support `stream:true` → SSE `delta`/`result`/`error`, with a pre-stream START fallback to the tenant's configured fallback provider. Governed template resolution by department code/name/v1-synonym. **R10 is fully served.** |
| `stt-compat` (`POST /api/stt/start_session`, `/switch`, `/stop_session`) + WS `/stt` | The v1 wire, including per-frame metadata (S4). Not used by the playground. |
| `streaming` (`/ws/stt/stream`, `stream/session`, `switch-to-primary|fallback`, `language-modes`) | The v2 wire the playground uses. |
| `audio/pipelines` ([audio-pipeline-public.controller.ts](apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts)) | `GET /api/v1/audio/pipelines` returns the tenant's pipelines, `@Authorize()`-gated. **Exists — the playground just doesn't use it**, which is why Pipeline ID is a hand-typed free-text field today. |

**Finding G1 — no gateway work is needed for R7/R8/R10.** The pipeline list, the switch routes, and SSE summarization are all live. The gaps are entirely client-side.

**Finding G2 — WER/CER has no TS implementation, but there is a Python reference.** [apps/stt/scripts/mlen_scorecard.py](apps/stt/scripts/mlen_scorecard.py) carries a Unicode-NFC-normalizing `_norm` + Levenshtein `cer` used by the TASK-594 quality gate. R6 must **port the same normalization**, or the playground's numbers will disagree with the regression gate for Malayalam. Do not invent a second normalization.

---

## 3. Gap Summary

| Req | Verdict | Work |
|---|---|---|
| R1 tabs | Restructure | App only |
| R2 per-tab example code | Restructure | App only (mechanism exists) |
| R3 audio sources | **Blocked** by S1/S2/S3 | SDK core + compat + app |
| R4 stop latency | **Defect** D1/D2 | App + SDK + Python |
| R5 metadata | Partial (S4/S5) | App (+ optional v1-wire demo) |
| R6 WER/CER | New | App (port G2 normalization) |
| R7 provider switch | **Shipped** | App: relocate + pipeline picker (G1) |
| R8 dept/visit/context | **Shipped** | App: relocate + fix A4 |
| R9 live caption → summary | At risk from A3 | App: lift state above tabs |
| R10 streaming toggle | SDK+gateway shipped | App: wire `stream`/`onDelta` |

---

## 4. Implementation Plan — parallel agent lanes

Eight lanes. Lane 0 is a **hard barrier** (every UI lane imports its context); lanes A–F then run fully parallel; lane G integrates.

### Tier assignment rationale

- **opus-5** — cross-layer changes that can break the durable transcript, the capture graph, or a frozen public contract.
- **sonnet-5** — well-specified single-surface work with an existing exemplar in-repo.
- **opus-4-8** — self-contained UI/algorithm work with clear acceptance criteria and no cross-layer blast radius.

| Lane | Scope | Tier | Depends on | Parallel |
|---|---|---|---|---|
| **0** | Tab shell + lifted session context | **opus-5** | — | ❌ barrier |
| **A** | Audio-source capability (SDK core + compat + UI) | **opus-5** | 0 | ✅ |
| **B** | Stop-latency fix (app + SDK + Python) | **opus-5** | 0 (app part) | ✅ |
| **C** | Metadata simulator over the mixed multi-mic stream | **sonnet-5** | 0, A (contract only) | ✅ |
| **D** | WER/CER reference scoring | **opus-4-8** | 0 | ✅ |
| **E** | Pipeline picker + provider toggle relocation | **sonnet-5** | 0 | ✅ |
| **F** | Summarization tab + streaming toggle | **sonnet-5** | 0 | ✅ |
| **G** | Per-tab example code, README, docs, integration verify | **opus-4-8** | all | ❌ last |

### Lane 0 — Tab shell + lifted session context — **opus-5**

The barrier. Everything else composes on its output.

1. `App.tsx` → three `TabsTrigger`s: `connection` · `live-transcription` · `summarization`. Tabs 2 and 3 are `disabled` with a visible reason until connected (WCAG: disabled ≠ silent).
2. Move `ConfigColumn` into the Connection tab as a full-width `ScreenTemplate`-style page.
3. **Lift session state out of `SessionWorkspace` into a `PlaygroundSessionProvider`** mounted *inside* `ArcaCompatProvider` and *outside* the `Tabs`. It owns: `lines`, `interim`, `isRecording`, `languageMode`, `captureStartRef`, and the `useArcaSessionManager` / `useAudioCapture` / `useArcaSpeechToText` instances. This is what makes R9 work across isolated tabs (Finding A3).
4. All three `TabsContent` panels get `forceMount` + `data-[state=inactive]:hidden` — the existing pattern in `App.tsx:58`. **A live capture session must never unmount when the user switches tabs.**
5. Keep `ArcaCompatProvider` mounted at exactly one place; remounting drops the store and kills the session.

*Gate:* switch tabs mid-recording — transcript keeps growing, mic stays live, provider toggle state survives.

### Lane A — Audio-source capability — **opus-5**

Touches the capture graph; a mistake here silently degrades every consumer of `@arcaai/vox`.

**A1 · SDK core** (`packages/agentic-sdk-v2/src/types/audio.ts`, `hooks/useArcaAudio.ts`)
- Extend `AudioStartOptions` **additively** (never break `deviceId`/`secondaryDeviceId`):
  ```ts
  /** Extra mics beyond primary+secondary; all mixed into one uplink stream. */
  additionalDeviceIds?: string[];
  /** Pre-built streams (e.g. file-backed) used INSTEAD of getUserMedia. */
  sourceStreams?: MediaStream[];
  ```
- In `startAudio`: when `sourceStreams` is present, skip `getUserMedia` entirely and feed those streams to the mixer. Otherwise enumerate `[deviceId, secondaryDeviceId, ...additionalDeviceIds]`.
- Generalize the mixer block ([useArcaAudio.ts:214-235](packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:214)) from a hard-coded pair to a loop over N sources with per-source gain. `AudioMixer.addSource(id, stream, gain)` already supports this (Finding S2).
- Track **every** secondary/injected stream for teardown — `secondaryStreamRef` is currently a single ref and will leak with N > 2.

**A2 · SDK compat** (`compat/useAudioCapture.ts`) — forward the new fields (Finding S1). Additive to `UseAudioCaptureProps`; the frozen v1 signature is unchanged.

**A3 · App** — an `AudioSourcePanel` in the Live-transcription tab:
- `navigator.mediaDevices.enumerateDevices()` → multi-select of `audioinput` devices, each with a gain slider and a mic label (`mic 1`, `mic 2`, …) used by lane C's metadata.
- **File mode**: one file per virtual mic (or one stereo file split L/R into two virtual mics). Decode with `AudioContext.decodeAudioData`, drive `AudioBufferSourceNode → MediaStreamAudioDestinationNode`, pass `.stream` in `sourceStreams`. Playback controls: play / pause / seek / loop / rate.
- **Modes:** `single mic` · `multi mic (mixed)` · `file → single mic` · `file(s) → multi mic (mixed)` — the exact four cells of the screenshot.
- Permission prompt must happen before device labels are readable; show a "Grant microphone access" affordance when labels are blank (`getDeviceStatus()` already infers this).

*Gate:* a 2-file multi-mic run produces one uplink stream and a transcript; unit tests cover the N-source mixer teardown; no leaked `MediaStreamTrack` after stop (assert `readyState === 'ended'` on every source).

### Lane B — Stop latency — **opus-5**

Three sub-parts, each independently shippable and independently revertible.

**B1 · App + SDK (perceived latency → ~0)**
- Reverse the order in the playground's `stop()`: **stop capture first**, then await the drain in the background.
- In `useArcaAudio.stopAudio`, stop the `MediaStream` tracks and set `isCapturing=false` **before** `await pluginManager.destroy()`. Fix D2 at the source so every consumer benefits, not just the playground.
- Introduce a UI state `stopping | finalizing` with a badge — tail finals still append while it shows.

**B2 · SDK (`SttWebSocketClient.stopAndDrain`)**
- Make `drainTimeoutMs` configurable via `AudioStartOptions`/provider config; default down from 5000 to ~1500 ms.
- Resolve the drain early on the **`finalizing`** status too when no further transcript has arrived for a short quiet window — not only on `closed`.

**B3 · Python (`apps/stt/src/stt/streaming/session_manager.py`) — the real fix**
- Publish `status: closed` **immediately after the last transcript is emitted and the inference queue is drained**, then perform MinIO uploads, `_register_dual_capture`, and `_persist_streaming_transcript`.
- **Invariants that must not move:** `session.close()` still runs in `finally`; capacity release still always happens; `_persist_streaming_transcript` stays inside finalize (durable system of record); the Redis outbox fallback stays intact. The subscriber completes on the terminal status, so verify no in-flight transcript can be emitted *after* `closed` (order: drain → last transcript → `closed` → persistence).
- Add a pytest asserting `closed` is published before the blob-upload calls, plus a replay of the existing streaming-quality integration suite.

*Gate:* measured wall-clock from click to `isRecording === false` < 150 ms; tail final still lands; `test-stt` green; no regression in `tests/integration/streaming_quality.py`.

### Lane C — Metadata over the multi-mic stream — **sonnet-5**

- Per-mic metadata rows in the controller: for each configured source, a `{mic, speaker}` pair plus free-form JSON, exactly the screenshot's shape.
- **Auto-tag mode**: when a source's level crosses a threshold, emit `sendAudioData(new ArrayBuffer(0), {mic, speaker})` — reproducing the screenshot's alternating colour bands automatically instead of by hand.
- Keep the manual "Send metadata" button (today's behaviour) for deterministic demos.
- **Be explicit in the UI about Finding S4/S5**: on the v2 wire this metadata is *client-side correlated*, replayed onto the next `onTranscript`; it is not carried on the socket. Put that in an inline note, not buried in the README.
- Validate against `MAX_METADATA_BYTES = 8192` before send (the hook throws today — surface it as a field error, not a toast).
- *Optional stretch (only if the lane finishes early):* a read-only "v1 wire" comparison note documenting the `/stt` frame-header path. **Do not** implement a second transport.

*Gate:* metadata round-trips onto the correct transcript row; the two-track timeline shows mic attribution; 8 KB guard covered by a test.

### Lane D — WER/CER — **opus-4-8**

- `src/lib/scoring.ts`: Levenshtein-based WER + CER. **Port `_norm` from [mlen_scorecard.py](apps/stt/scripts/mlen_scorecard.py) verbatim in behaviour** — Unicode NFC, case/punctuation handling — so the playground and the TASK-594 quality gate agree on Malayalam (Finding G2). Cite the source file in a header comment.
- Reference input: textarea paste **or** `.txt`/`.srt`/`.vtt` upload; store per-run alongside the file-source selection.
- Live scorecard: WER, CER, substitutions/insertions/deletions, and a word-level aligned diff (colour + icon, never colour alone — §11 accessibility).
- Export the run as JSON (reference, hypothesis, scores, pipeline id, language mode, audio source) so runs are comparable across pipeline switches.
- Unit tests including a Malayalam code-switch case with a known expected CER.

*Gate:* scores match `mlen_scorecard.py` on at least two shared fixtures.

### Lane E — Pipeline picker + provider toggle — **sonnet-5**

- `src/lib/pipelines.ts` mirroring `departments.ts`: `GET /api/v1/audio/pipelines` with `x-api-key`, defensive envelope unwrap, graceful fallback to the current free-text input on 401/403/empty.
- Connection tab: Pipeline ID becomes a `<Select>` of real pipelines (id + name + slug), free-text `Custom…` retained.
- Move `ProviderToggle` into the Live-transcription tab; keep `useArcaSttProvider` untouched (R7 is already correct).
- Surface the pre-start selection state clearly: before capture exists the toggle records a pending choice (`pendingSttProvider`) rather than switching — today the badge just says `switched`, which is misleading pre-session.

*Gate:* toggle flips mid-session with no reconnect and the transcript keeps flowing (the existing TASK-586 behaviour must not regress).

### Lane F — Summarization tab + streaming toggle — **sonnet-5**

- Move `SummaryCard` into its own tab, decomposed (it is 467 LOC): `ContextForm`, `TranscriptSource`, `SummaryResultView`.
- Consume the live transcript from lane 0's context (R9), with an explicit source control: `live transcript` · `pasted` · `live + additional context`. Show the live line count and let the developer edit a copy without destroying the live buffer.
- **Streaming toggle (R10)** — wire the already-shipped SDK path: `preSummarize({...,stream:true,onDelta})` and `summarizeSync({...,stream:true,onDelta})`, rendering tokens as they arrive with a live token counter; off → today's single-response path. Both `/summary/sync` and `/presummary` support it server-side.
- Fix **A4**: align presets with the README (or update the README — pick one) and make the seeded default a value that exists in the list.
- Keep `Skeleton` loading (never a spinner) and `toast.success/error` on every action.

*Gate:* streaming and non-streaming produce equivalent final summaries against the same transcript; SSE `error` frames surface as a toast, not a silent stall.

### Lane G — Example code, docs, integration — **opus-4-8**

- Re-scope `ExampleCode` into a `<TabExampleCode files={[...]} />` rendered at the **end of each tab** with only that tab's real files. Keep `import.meta.glob(?raw)` — add the new paths to the glob array (it is static-analysed by Vite; a missing entry silently yields an empty block, so assert non-empty in a test).
- Rewrite [apps/compat-playground/README.md](apps/compat-playground/README.md) for the three-tab structure; correct the stale visit-type table (A4).
- Update this ticket README with the Implementation Summary + evidence.
- Full verification: `pnpm --filter @arcaai/compat-playground test typecheck build`, `pnpm --filter @arcaai/vox test build`, `pnpm stt:test`, `pnpm --filter @arcaai/api test:unit`, plus a manual pass in a real browser (mic permission, file playback, both themes, axe scan).

---

## 5. Sequencing

```
Lane 0 (opus-5) ──── barrier ────┐
                                 ├── A (opus-5)    audio sources
                                 ├── B (opus-5)    stop latency
                                 ├── C (sonnet-5)  metadata
                                 ├── D (opus-4-8)  WER/CER
                                 ├── E (sonnet-5)  pipelines + toggle
                                 └── F (sonnet-5)  summarization
                                          └──────── G (opus-4-8) docs + integrate
```

**File-ownership map (prevents merge conflicts across parallel lanes):**

| Lane | Exclusive files |
|---|---|
| 0 | `App.tsx`, `context/playground-session.tsx`, `components/ConnectionTab.tsx` |
| A | `types/audio.ts`, `hooks/useArcaAudio.ts`, `compat/useAudioCapture.ts`, `components/AudioSourcePanel.tsx` |
| B | `core/SttWebSocketClient.ts`, `session_manager.py`, `hooks/useArcaAudio.ts` **(stop path only)** |
| C | `components/MetadataSimulator.tsx` |
| D | `lib/scoring.ts`, `components/ScorecardPanel.tsx` |
| E | `lib/pipelines.ts`, `components/ProviderToggle.tsx`, `components/PipelinePicker.tsx` |
| F | `components/summarization/*` |
| G | `components/TabExampleCode.tsx`, READMEs |

> ⚠️ **A and B both touch `useArcaAudio.ts`.** A edits `startAudio`, B edits `stopAudio`. Assign B's `useArcaAudio` hunk to lane A's agent, or serialize B1 after A — do not let two agents edit that file concurrently.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **B3 reorders the durable transcript path** | Publish-earlier only; persistence stays inside finalize; add an ordering test; revertible independently of B1/B2 |
| **Tab isolation kills the live session** | `forceMount` on all panels + a single provider mount point (lane 0 gate) |
| **N-source mixer leaks tracks** | Explicit teardown test asserting every source track ends |
| **File-backed streams bypass real capture semantics** | Route them through the *same* mixer → noise-filter → VAD → STT graph; never a separate code path |
| **Metadata claims more than it delivers** | Explicit in-UI note that the v2 wire correlates client-side (S4/S5) |
| **CER disagrees with the STT quality gate** | Port `_norm` behaviour verbatim; cross-check on shared fixtures (lane D gate) |
| **`@arcaai/vox` is a published SDK** | Every SDK change is additive-optional; existing v1 signatures frozen; contract tests in `compat/__tests__/contract.test.ts` must stay green |

---

## 7. Verification Criteria

Filled in by lane G, 2026-08-01. ✅ = verified with evidence · ⚠️ = partially verified,
gap named · ❌ = not verifiable in this session.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Three isolated tabs; 2 and 3 gated on connection with a visible reason | ✅ | `App.tabs.test.tsx` (panel-identity assertions, not naive `forceMount`); confirmed live in a browser — locked tabs + the "Two tabs are locked" alert, unlocking on Connect |
| 2 | Per-tab example code at page end, loaded from disk, non-empty (asserted) | ✅ | `TabExampleCode.test.tsx` (28 tests) loads all 22 registered files and asserts >200 chars each. **RED verified by mutation**: deleting one path from the `import.meta.glob` array fails exactly one test. Confirmed live on all three tabs — real source rendered, no empty blocks |
| 3 | Single mic / N mics / file→single / files→N-mixed all transcribe | ⚠️ | Unit-covered end to end (`use-audio-sources`, `file-audio-source`, `AudioSourcePanel`, `useArcaAudio.sources.task597`). **No live transcription performed — no gateway, no STT, no microphone in this session.** |
| 4 | Stop returns the UI to idle in < 150 ms; mic indicator off; tail final still lands | ⚠️ | Structural + test-proven (`useArcaAudio.stopOrder.task597.test.ts`, `playground-session.capture.test.tsx`; both RED-verified by reverting the ordering). **Not measured on a stopwatch against live infra.** |
| 5 | Per-mic metadata round-trips onto the correct transcript row | ✅ | `MetadataSimulator.test.tsx` (round-trip + 8 KB guard + auto-tag debounce); lane G added visible `mic`/`speaker` badges on the timeline — `TranscriptColumn.test.tsx` |
| 6 | WER/CER match `mlen_scorecard.py`; run exportable as JSON | ✅ | 11 shared fixtures compared at full float precision against the real Python, hard-coded as exact expectations (`scoring.test.tsx`); export now carries a real `run.audioSource` (`ScorecardPanel.test.tsx`) |
| 7 | Pipeline picker lists real pipelines; toggle flips mid-session without reconnect | ⚠️ | Picker verified against a mocked fetch incl. the new debounce; the free-text fallback confirmed live (no gateway → free text, correct). **`GET /api/v1/audio/pipelines` has still never been called against a running gateway; the mid-session toggle has never been exercised live.** |
| 8 | Department/visit/context → pre-summary → summary; live caption reachable from Summarization | ✅ (wiring) / ⚠️ (round trip) | `SummaryCard.test.tsx` (12); the tab reads the transcript from the lifted context, verified by test. **No SMR call made — no gateway.** |
| 9 | Streaming toggle renders tokens live; non-streaming returns the final body | ⚠️ | `{stream:true,onDelta}` threading asserted in `SummaryCard.test.tsx`. **No real SSE stream observed.** |
| 10 | `pnpm --filter @arcaai/compat-playground test typecheck build` | ✅ | 173 tests / 15 files passed; `tsc --noEmit` clean; build ✓ in 17.39s (with the known ~6 MB chunk warning — reported below, not silenced) |
| 11 | `@arcaai/vox` test + typecheck + build | ✅ | 3771 tests / 221 files passed; typecheck exit 0; tsup build success |
| 12 | `pnpm stt:test` | ⚠️ | 2840 passed, 77 skipped, 3 xfailed, **1 failed** — `test_asr_engines.py::TestP507WhisperCppEngine::test_adapter_contract`, **pre-existing and reproduced with the HEAD copy of `whisper_cpp_asr.py`** (see §8 lane G) |
| 13 | `pnpm --filter @arcaai/api test` | ✅ | 2307 passed / 8 skipped, 165 files |
| 14 | Python lint / typecheck | ✅ / ⚠️ | `pnpm stt:lint` (ruff) — All checks passed. `pnpm stt:typecheck` (mypy) — exactly 1 error, the pre-existing `session_manager.py:893` |
| 15 | **NEW** — the app has a working `lint` gate | ✅ | `eslint.config.mjs` added; `pnpm --filter @arcaai/compat-playground lint` → clean at `--max-warnings 0` |
| 16 | Both themes verified | ✅ | Driven live in a browser, light **and** dark; semantic tokens only, `<Skeleton>` (not spinners) for the pending device list |
| 17 | axe scan 0 violations | ⚠️ **1 violation** | axe-core 4.12.1, WCAG 2.0/2.1/2.2 A+AA, both themes, all three tabs: **1 serious `scrollable-region-focusable`**, 24 passes, 0 incomplete. Cause is `packages/ui`'s `CodeExample`: its `<pre className="overflow-x-auto …">` (`packages/ui/src/components/custom/code-example.tsx:56`) is horizontally scrollable but not keyboard-focusable. **Pre-existing in a shared primitive, not introduced here** — it applied to the old single "Example code" tab too; per-tab rendering only makes it appear on three tabs instead of one. Deliberately NOT fixed by lane G: it is a shared `@arcaai/ui` primitive consumed by the admin console and Storybook, outside this ticket's surface. Recorded as an open follow-up |

---

## 8. Execution Log

Plan approved 2026-08-01; execution started same day.

### Deviations from §4/§5, decided at dispatch

1. **Tier mapping.** The agent runner exposes `opus | sonnet | haiku` only, and reasoning effort is not a per-agent parameter outside workflow scripts. So `opus-5 → opus`, `sonnet-5 → sonnet`, `opus-4-8 → opus`. Tier *intent* (which lane gets the strongest model) is preserved; the 4.8 tier is not separately selectable.

2. **Lane B split in two.** §5 flagged that lanes A and B both edit `useArcaAudio.ts`. Resolved by splitting rather than serializing the whole lane:
   - **B-server** (dispatched with the parallel wave): B2 transport (`SttWebSocketClient`, `StreamingBackendSTTProvider`) + B3 Python (`session_manager.py`). No overlap with lane A.
   - **B-client** (deferred until lane A reports): B1, the `stopAudio` reorder + app-level `stopping|finalizing` state.
   - Consequence: B2 makes `drainTimeoutMs` configurable at the **client/provider level, not via `AudioStartOptions`** (lane A owns `types/audio.ts`). Threading it through `AudioStartOptions` is a follow-up.

3. **Shared-context contention reduced from 4 lanes to 2.** Lane 0 created `playground-session.tsx` with grouped slices. Rather than have A/C/D/E all edit it concurrently:
   - **A** adds a new `audio` group; **C** extends the existing `metadata` group (both warned it is co-edited, with a re-read-and-retry instruction).
   - **D** keeps reference-transcript + score state local to `ScorecardPanel`, reading `transcript.lineTexts`.
   - **E** uses the existing `PlaygroundConfig.pipelineId` + `config-store` instead of a new group.
   - **F** is a pure reader.

### Lane 0 — complete (opus)

Three tabs; `PlaygroundSessionProvider` mounted inside `ArcaCompatProvider` and outside `Tabs`; all panels `forceMount`. Created `context/playground-session.tsx`, `ConnectionTab`, `LiveTranscriptionTab`, `SummarizationTab`; deleted `ConfigColumn`, `SessionWorkspace`, `DisconnectedColumns`. typecheck/test/build green (8 tests).

Context value groups: `{config, session, capture, transcript, language, metadata}`, each with an exported `Playground*Slice` type. **Extension rule: a new concern adds a new top-level group; never widen an unrelated one.**

**Trap recorded for every later lane:** a naive `forceMount` assertion is a fake gate — Radix `Presence` renders the `<div role="tabpanel" hidden>` wrapper even without `forceMount` (it only gates `present && children`). The test must assert identity of each panel's **first child**. Verified by mutation: deleting one `forceMount` now fails the test.

Lane 0 also confirmed finding A4 is still live and left it for lane F, and noted `ExampleCode.tsx` is now unreferenced with three dead glob paths — lane G must re-scope it and add the four new component paths.

### Lane E — complete (sonnet)

`lib/pipelines.ts` + `PipelinePicker` (three-state `loading | list | freetext`, mirroring the department picker), wired into the Connection tab replacing the free-text pipelineId input. Adds an explicit "Tenant default (no pipeline)" entry and a permanent `Custom…` escape hatch.

Pre-session badge fixed: `useArcaSttProvider` reports `switchStatus: 'switched'` even for a pre-capture `pendingSttProvider` selection, which read as "the engine changed" when nothing had. Now shows `pending` / `fallback queued` when `activeProvider === null`. The hook itself was not touched (R7 stays as shipped).

Relocation (§4 lane E item 4) was already satisfied by lane 0 — `ProviderToggle` had moved into `LiveTranscriptionTab`'s controller column. No edit needed.

27 tests green; typecheck + build clean.

**Carried to lane G:**
1. `PipelinePicker` re-fetches on every keystroke in the Connection-tab draft (no debounce). Stale responses are correctly discarded via a `cancelled` guard, so there is no race — but it means partial API keys are sent to the gateway repeatedly while the developer types, which is log noise and poor credential hygiene. **Debounce it, or defer the fetch until the field blurs / Connect is pressed.**
2. `GET /api/v1/audio/pipelines` was verified by reading the controller + DTO only; no gateway was running. Unit tests use a mocked fetch. Needs a live check in lane G's integration pass.

### Lane F — complete (sonnet)

`SummaryCard` decomposed 467 → ~250 LOC orchestrator + `summarization/{ContextForm,TranscriptSource,SummaryResultView}`. 12 tests green; build clean.

**R10 streaming toggle** wired on both `preSummarize` and `summarizeSync`. On the terminal `result` event the same `setPreSummary`/`setSummary` path runs as the non-streaming case, so final rendering is identical either way. SSE `error` frames and the "stream ended without a result event" rejection both arrive as plain `Error`s from `useSMR` and hit the existing `toast.error` — no special-casing needed.

> **Worth knowing when demoing:** the gateway's `streamGenerate` re-emits SMR `chunk` frames as `delta`, i.e. **raw text, not partial structured JSON**. So with Enhanced/SOAP formats the live stream shows unstructured model output and only snaps into the structured view on the terminal `result`. That is the real backend behaviour, not a UI shortcut — the streaming preview is labelled accordingly.

**R9 transcript source** is now an explicit 3-way selector (`live` · `pasted` · `live + additional context`), replacing the old implicit "non-empty paste silently wins" rule. `pasted` is an independent buffer seeded by an explicit one-time "Copy live transcript" snapshot, so editing never mutates the live buffer.

**Finding A4 fixed.** The dead `'New Patient'` seed is gone; `SummaryCard` holds a single always-effective `visitType`, and `ContextForm` derives list-vs-custom once at mount — so a legacy stored value now opens in custom mode with a real matching sentinel selected instead of an empty `<Select>`. The app README's visit-type bullet was corrected to the two-preset model (rest of that README left to lane G).

**Carried to lane G:** this app has no `lint` script and no `eslint.config.js` — `pnpm lint` cannot run against it. Decide whether to wire it up or document the exemption.

### Lane D — complete (opus)

`lib/scoring.ts` (WER/CER + S/I/D + word alignment, rolling-cost DP with a `Uint8Array` backpointer table), `ScorecardPanel`, 39 tests green, typecheck + build clean. Reference input accepts paste or `.txt`/`.srt`/`.vtt`; JSON export carries pipeline id, language mode, session id, reference source, normalized strings and the alignment. Word diff uses colour **plus** a `~`/`+`/`−` marker **plus** an `sr-only` op name (asserted by test), satisfying §11 "never colour alone".

**Parity with `mlen_scorecard.py` proven, not assumed** — 11 shared fixtures compared at full float precision against the real Python `_norm`/`cer`, all 11 identical, and hard-coded as exact expectations so future drift fails CI. Two load-bearing cases (`case-sensitive = 0.190`, `punctuation-kept = 0.154`) prove neither side folds case or drops punctuation.

**What the port revealed about the reference implementation** (`_norm`, `mlen_scorecard.py:43`) — all preserved deliberately rather than "improved":
- It does **exactly three things**: NFC → collapse whitespace runs → strip. It does **not** lowercase, strip punctuation, normalize digits, or transliterate, despite the script's "transliteration-agnostic" docstring. The docstring oversells it.
- `cer()` uses a `max(1, len(ref))` denominator, so an **empty reference returns the raw edit distance, not a ratio** — `cer('', 'hello') == 5`. The TS port reproduces this for parity. ⚠️ **Candidate upstream fix for the TASK-594 owner**: worth deciding whether an empty-reference clip should score 5.0 or be excluded from the scorecard.
- Two language-level traps closed explicitly: Python `\s` ≠ JS `\s` (Python matches U+001C–U+001F and U+0085; JS instead matches U+FEFF), so the character class is spelled out rather than using `\s`; and Python iterates code points while JS indexes UTF-16 code units, so all character work goes through `Array.from()`. Without these two, Malayalam scores would silently diverge.

**Two judgement calls that improved on the plan:**
- **SRT/VTT cue-identifier detection is structural, not numeric.** The plan said "strip indices"; a naive `/^\d+$/` would delete a cue whose spoken text is literally `500` — realistic in a dosage transcript, and it would silently corrupt the reference. An identifier is instead detected as the first line of a block whose next line is a timecode. Regression-tested.
- **`scoring.test.ts` renamed to `.test.tsx`** — the app's `vitest.config.ts` collects only `src/**/*.test.tsx`, so a `.test.ts` would have been silently skipped by the required verification command. Renamed rather than editing the shared vitest config mid-parallel-run.

**Carried to lane G:** `audioSource` in the JSON export is honestly `null` — lane A's `audio` context group did not exist when lane D ran, and lane D was correctly barred from editing that file. One-line wiring follow-up.

### Lane A — complete (opus)

`AudioStartOptions` gains three additive-optional fields — `additionalDeviceIds?: string[]`, `sourceStreams?: MediaStream[]`, `sourceGains?: number[]` (the last was not in the brief; added because the panel spec needs per-source gain and `AudioMixer.addSource(id, stream, gain)` is the only way to apply it — **accepted**). Resolved source order is `sourceStreams` when present, else `[deviceId, secondaryDeviceId, ...additionalDeviceIds]` deduped. Exactly one source → no mixer, pre-597 behaviour byte-identical.

`secondaryStreamRef` → `sourceStreamsRef: useRef<MediaStream[]>([])` holding every stream the session owns, registered before acquisition so a mid-way `getUserMedia` rejection still leaves earlier mics reachable. `startAudio`'s `catch` now stops all acquired streams before rethrowing — **a failed start previously left the mic hot and the indicator lit.**

⚠️ The teardown loop deliberately EXCLUDES tracks belonging to `store.activeStream` (the block below already stops those); `useArca.audio-unification.test.ts` asserts the mic is released **exactly once**. Any future edit to `stopAudio` must preserve this.

App: `AudioSourcePanel`, `lib/file-audio-source.ts`, `hooks/use-audio-sources.ts` (5th file, not in the ownership map — the state must live above the tabs to feed `useAudioCapture`; putting it in the panel would force a runtime import cycle with the context). File playback follows the record lifecycle (auto-play on Start, pause on Stop) because a paused file source feeds silence, indistinguishable from a broken STT session.

vox: 3764 tests / 220 files green. Playground: 131 tests / 12 files green. Typecheck + build clean.

**Deliberate non-deviation:** no store-backed fallback for source options. A `MediaStream` is a live non-serializable resource; parking one in the shared store makes ownership and teardown ambiguous. The playground starts capture first, so the `useAudioCapture` path wins the start race. Documented in the hook's JSDoc.

**For lane C:** `audio.sources` is `{ id, micLabel: 'mic 1' | 'mic 2' …, sourceLabel, gain }[]`, ordered by mixer position, stable for a run, identical shape in mic and file modes.

### Lane B-server — complete (opus)

**B3 (the real fix).** `publish_status("closed")` moved out of the `finally` block to immediately after the `finalizing` publish and **before** `_get_blob_service()`. New order: drain → last transcript → cancel in-flight partial → `closed` → uploads → dual-capture → transcript persistence → `session.close()` → `remove_session()`.

Ordering proven safe, not assumed: all four finalize entrypoints drain before calling `_finalize_session`; nothing inside `_finalize_session_locked` publishes a transcript; the one remaining in-flight publisher (a partial task) is now explicitly cancelled immediately before the publish, converting "no transcript after `closed`" from a race into a guarantee. Terminal semantics confirmed at the consumer (`streamingAudioBridge.service.ts:648`). All §4 invariants held — `session.close()` still in `finally`, capacity release unconditional, `_persist_streaming_transcript` still inside finalize with its outbox fallback, `_finalize_locks` idempotency untouched. If the early publish raises it is logged and the `finally` re-publishes, guarded so it never double-publishes.

**B2.** Drain default 5000 → 1500 ms, configurable via a new optional `WsDrainOptions` constructor param (client/provider level, not `AudioStartOptions`, per the dispatch deviation) plus `StreamingRemoteProviderConfig.drainTimeoutMs`. Early resolve: a `finalizing` status opens a 250 ms quiet window that **every transcript restarts**, so a still-streaming tail is never cut off; transcripts alone do not open it, or an ordinary lull would close a drain the server never acknowledged.

Tests: 6 new Python ordering tests (**RED verified** — 4 of 6 fail against `HEAD`), +9 `SttWebSocketClient`, +3 provider. One existing test was *changed, not adapted away*: `test_finalize_calls_sequence_in_correct_order` asserted the old order and **is** the old contract.

> ⚠️ **The `finalizing` early-resolve is currently INERT on the v2 wire.** `parseAndEmitResult` relays only `provider_switched` among non-terminal statuses, so `finalizing` never reaches the browser. The code is correct and tested but only pays off once someone relays `finalizing` through `packages/applications` + the gateway. B3 makes `closed` arrive fast anyway, so this is belt-and-braces. **Follow-up candidate, not a blocker.**

**Pre-existing failures confirmed NOT caused by this lane:** `test_asr_engines.py::test_adapter_contract` (fails on the staged TASK-594 `whisper_cpp_asr.py` change that dropped `split_on_word`) and one mypy error at `session_manager.py:893` (byte-identical at `HEAD`).

Integration suites: 6 passed / 44 skipped — **every finalize-touching harness self-skips without live infra**, so none of them exercised this change. Needs `pnpm setup:test` + live STT/API to be meaningful. Recorded as a real gap, not a pass.

**Handoff that changed lane B-client's scope** — three serial blockers remain on click→idle, and #2 was not in B1's brief:
1. `stopAudio` tears down the transport before stopping the tracks (D2 — B1's core fix).
2. `StreamingBackendSTTProvider.destroy()` awaits `session.closeSession()` **after** the drain; that DELETE hits STT `end_session` → `_finalize_session` → **blocks on the same per-session finalize lock the first finalize still holds while uploading to MinIO**. The uploads moved off the caption path are still on the *teardown* path via this second entrypoint. Already best-effort, so it should be fire-and-forget. **Now the largest remaining serial wait.**
3. The playground's `stop()` awaits STT before capture — the cheapest win.

B1 was re-scoped mid-flight to cover all three.

### Lane B-client — complete (opus)

All three remaining serial blockers on click→idle closed, in the order B-server handed them over.

**1. `useArcaAudio.stopAudio` reordered (D2, the core fix).** The teardown block — level meter, uplink poller, `AudioMixer.dispose()`, every `sourceStreamsRef` stream, `activeStream`, and the `isCapturing`/`isSpeaking`/`audioLevel`/`currentTranscript` resets — moved AHEAD of `await pluginManager.destroy()`. That block is synchronous, so the mic is released and `isCapturing` is false **before the function reaches its first `await`**. The plugin callbacks stay wired across the drain, so a tail final still lands in `transcriptSegments`.

Three orderings inside it are load-bearing and are commented as such:
- **The dual-capture flush stays FIRST.** `DualStreamRecorder.stop()` waits on `MediaRecorder.onstop`; once its stream has gone inactive that call throws `InvalidStateError` and the awaited promise never settles — stopping tracks first would have turned a latency bug into a permanent hang. It is a local encoder flush (ms, LOCAL workflow only), so it never puts the transport on this path.
- **The mixer-then-sources-then-`activeStream` sequence is untouched**, preserving lane A's exactly-once mic release (`useArca.audio-unification.test.ts`).
- **`resetAudioDropped` / `setSttConnectionState` / `setActivePipeline` stay AFTER the drain** — `destroy()` fires its own disconnect callbacks, which would overwrite a reset done before it.

**New: an in-flight guard.** `stopAudio` now returns the in-flight promise to a concurrent second caller. This is not defensive dressing — the compat layer drives one graph through two hooks (`stopRecording` + `stopTranscription`), both guarding on a *render-time* `isCapturing` snapshot, so a same-tick double stop was guaranteed. Post-reorder that second call would have found nothing left to release and gone straight to a second `pluginManager.destroy()` — a second drain wait, re-adding the latency just removed.

**2. `StreamingBackendSTTProvider.destroy()` no longer awaits `session.closeSession()`.** The call stays (the backend must still be told) but is fire-and-forget with both a sync throw and a rejection absorbed, so it cannot surface as an unhandled rejection. Its failure was already swallowed, so nothing is lost. This was the largest remaining wait: the DELETE re-enters `_finalize_session` and blocks on the finalize lock the first finalize holds while uploading.

**3. Playground `stop()` reversed** — `capture.stopRecording()` issued first, with `stt.stopTranscription()` issued in the SAME tick so it joins that teardown via the guard (it still runs for its own sake: it resets the metadata timeline). The returned promise deliberately still spans the drain, so Start cannot be re-armed on a half-closed session.

**`capture` group is now `{ isRecording, isStarting, phase, start, stop }`** with `phase: 'idle' | 'starting' | 'recording' | 'stopping'`. `isRecording`/`isStarting` are unchanged for lanes C/E/F and the tab tests. `stopping` is a real state — mic already off, transport still finalizing — so the Recording card's Stop button reads **"Finalizing…"** with a `role="status"` line saying the mic is released and the last lines are still arriving; Start is gated on `phase !== 'idle'`, not on `isRecording`.

**RED verified for both ordering changes** (the point of the lane is sequence, so presence-only assertions would have proved nothing): with the destroy hoisted back to the top of `stopAudio`, 4 of 7 new SDK tests fail; with the playground's old `stt`-then-`capture` order restored, 4 of 5 new app tests fail. Both patches reverted and the files byte-compared against their pre-proof copies.

Tests: `useArcaAudio.stopOrder.task597.test.ts` (7) asserts tracks ended + `isCapturing:false` ordered *before* `destroy-resolved`, a tail final delivered mid-drain reaching `addTranscriptSegment`, connection signals reset only after, and the three re-entrancy shapes. `playground-session.capture.test.tsx` (5) asserts the call order, the `stopping` phase across the drain, Start refusing to re-arm during it, and a tail final appending to `transcript.lines` after the mic is off. +2 provider tests for the non-blocking close (including a never-settling close and an unhandled-rejection assertion).

vox 3771/221 green, stt 429/25 green, playground 136/13 green; vox typecheck + build and playground typecheck clean.

**Perceived stop latency is now the React commit after a synchronous teardown — sub-frame, ~0 ms.** What still bounds the *promise* (not the UI): `stopAndDrain`, i.e. how fast the server emits its last transcript, with B-server's 1500 ms ceiling reachable only if the server never answers. Not measured against live infra — no gateway/STT/mic in this session; the ~0 ms claim is structural (the teardown block contains no `await`), proven by test rather than by stopwatch.

**Carried to lane G:** the `stopping` phase is surfaced only in the Recording card. `AudioSourcePanel` and `MetadataSimulator` still gate on `capture.isRecording`, which now goes false at click — file playback therefore stops at click rather than at end-of-drain (arguably correct, but it is a behaviour change worth a look), and the metadata form disables itself during finalization.

### Lane C — complete (sonnet)

`MetadataSimulator` extracted from `ControllerColumn`, carrying the S4/S5 honesty note, the frozen manual form, and a new per-mic-rows + auto-tag panel. 131 playground tests green (13 new); typecheck + build clean. Context `metadata` group extended in place with `sendError`, `rows`/`addRow`/`removeRow`/`updateRow`/`sendRow`/`rowErrors`, `syncRowsFromSources`, and the auto-tag knobs. Concurrent Edit conflicts with lanes A and B were re-read and reconciled, never overwritten.

The 8 KB guard is pre-validated (mirroring the SDK's own `MAX_METADATA_BYTES` check) and surfaced through `FieldError` with `role="alert"` — an inline field error, not a toast.

`rows` starts as a self-sufficient manual 2-slot list so the lane was never blocked on lane A; `MicRowsCard` reads `audio?.sources` defensively and offers an explicit "Sync rows from audio sources" button rather than auto-overwriting the developer's manual edits.

> ⚠️ **Auto-tag cannot do true per-mic attribution, and says so.** The SDK exposes exactly ONE mixed-stream level meter (`useAudioCapture().getDeviceStatus()`), not a per-source signal. Rather than overclaim, auto-tag rotates round-robin through the configured rows on each debounced threshold crossing, and the UI states the limitation. Debounce is rising-edge with re-arm-on-drop (not a fixed cooldown), fake-timer verified: a continuously-held level fires exactly once; dropping and re-crossing fires again on the next row.
>
> **Follow-up option if real attribution is wanted:** `AudioMixer` already builds a per-source node graph, so a per-source `AnalyserNode` (mirroring the single mixed-stream analyser `useArcaAudio` already attaches) would give genuine per-mic level and make auto-tag truthful. Scoped SDK change, not attempted here.

**Carried to lane G:** `TranscriptColumn`'s `MetadataCell` renders dedicated badges only for `speaker_id`/`detected_language`/`chunk_id`/`startTime`/`endTime`. The literal `mic`/`speaker` keys from the reference screenshot therefore appear only inside the collapsible raw-JSON block, **not as a visible badge on the timeline** — which is precisely the attribution the screenshot is about. Lane C correctly did not restructure a file it did not own. **Lane G should add mic/speaker badges.**

### Lane G — complete (opus)

**R2 · per-tab example code.** `ExampleCode.tsx` (unreferenced since lane 0, three
dead glob paths) replaced by `TabExampleCode.tsx`. The mechanism is preserved
exactly — `import.meta.glob(…, {query:'?raw'})`, lazy, reading real source off
disk — only the scoping changed. Each tab renders `<TabExampleCode files={…} />`
at page end with **only its own** files:

| Tab | Files |
|---|---|
| Connection (5) | `App.tsx`, `components/ConnectionTab.tsx`, `components/PipelinePicker.tsx`, `lib/pipelines.ts`, `lib/config-store.ts` |
| Live transcription (11) | `context/playground-session.tsx`, `components/LiveTranscriptionTab.tsx`, `components/AudioSourcePanel.tsx`, `hooks/use-audio-sources.ts`, `lib/file-audio-source.ts`, `components/ControllerColumn.tsx`, `components/ProviderToggle.tsx`, `components/MetadataSimulator.tsx`, `components/TranscriptColumn.tsx`, `components/ScorecardPanel.tsx`, `lib/scoring.ts` |
| Summarization (6) | `components/SummarizationTab.tsx`, `components/SummaryCard.tsx`, `components/summarization/{ContextForm,TranscriptSource,SummaryResultView}.tsx`, `lib/departments.ts` |

The empty-glob trap is closed twice, not once: `loadExampleSource` **rejects** on
an unglobbed path instead of resolving to `''` (an empty `<CodeExample>` is
visually indistinguishable from a collapsed one), and the test loads every file
of every tab and asserts >200 chars. **RED verified by mutation** — removing one
path from the glob array fails exactly one test; the file was restored and
byte-compared.

**Carried-forward fixes (all five).**

1. **Mic/speaker badges.** `MetadataCell` now renders first-class badges for the
   literal `mic` and `speaker` keys the per-mic rows send — the attribution the
   reference screenshot is *about*, previously visible only inside the
   collapsible raw-JSON block. `speaker_id` was relabelled `speaker_id:` so it is
   no longer confusable with the row-level `speaker`. New `TranscriptColumn.test.tsx`.
2. **Pipeline-picker debounce.** 400 ms (`PIPELINE_FETCH_DEBOUNCE_MS`), so a
   partially-typed API key is no longer sent to the gateway once per keystroke.
   The `cancelled` stale-response guard is unchanged — clearing the timer only
   suppresses requests not yet issued. Fake-timer test: five value changes inside
   the window ⇒ exactly one fetch, carrying only the final key.
3. **Scorecard `audioSource`.** Wired from `usePlaygroundSession().audio` via an
   exported pure `describeAudioSource()`. It returns `null` rather than a guess
   where there is genuinely nothing to describe (file mode, no file loaded), and
   names the implicit `system default microphone` for a mic mode with no explicit
   selection. Gain is spelled out only when off unity.
4. **`phase` vs `isRecording` — decided per control, and documented in code.**
   - `AudioSourcePanel` locking → **`phase !== 'idle'`**. It must stay locked
     through `stopping`, or the panel would describe a configuration the
     just-closed run never used. Own reason string for the drain window.
   - `AudioSourcePanel` file playback → **pause at the Stop click is correct**,
     kept, and now expressed as `phase === 'recording'` with the reasoning inline:
     `stopAudio` ends every source track synchronously at the click, so the
     file-backed `MediaStream` is already dead — playing on would advance a clock
     feeding nothing. (This is the one carried item where the answer was "the
     existing behaviour is right, make it deliberate", not "change it".)
   - `MetadataSimulator` send controls → **usable through `stopping`**
     (`canAttachMetadata`). Metadata replays onto the NEXT `onTranscript`, and
     tail finals arrive for the whole drain; gating on `isRecording` disabled the
     form exactly when the last lines were landing.
   - `MetadataSimulator` auto-tag → **`recording` only**. It reads the live input
     level, and there is no level once the mic is released.
   `AudioSourcePanel.test.tsx`'s fixture predated `phase`; it now derives `phase`
   the way the provider does (so `isRecording: true` fixtures keep exercising the
   real gating) plus an explicit `stopping` case.
5. **Lint wired.** `eslint.config.mjs` on `@arcaai/config-eslint/flat/react-library.js`
   — the right preset: a bundled React/TS surface with no Next runtime, so
   `flat/next.js` would register the wrong plugin and `flat/nestjs.js` is the API's.
   Scripts `lint` (`eslint src --max-warnings 0`, **no** `--fix`) + `lint:fix`,
   matching `@arcaai/ui`/`@arcaai/admin-console`; root aliases `compat:lint` /
   `compat:lint:fix` added to the `<target>:<action>` taxonomy. The preset spreads
   `flat/library.js`, which loads `only-warn`, so findings are warnings — hence
   `--max-warnings 0`.

   > The first run reported **126 findings, 124 of them `prettier/prettier`** —
   > i.e. this app had never been formatted to the repo's Prettier config. Fixed
   > with `lint:fix`; the resulting diff across other lanes' files is
   > **formatting only**. The 2 real findings were `no-explicit-any` on two
   > test-fixture arrays, replaced with a named `FakeBufferSource` interface and
   > `ReturnType<typeof makeBuffer>[]`.

**Docs.** `apps/compat-playground/README.md` rewritten for the three-tab console
(the old one still described the deleted `SessionWorkspace`/`ConfigColumn`/
`DisconnectedColumns` and a three-column workspace). Lane F's corrected
visit-type bullet was preserved verbatim. It now documents audio sources incl.
file simulation, the reactive stop and the `phase` contract, per-mic metadata
with both honesty notes reproduced, WER/CER + the `mlen_scorecard.py` parity
warning, the pipeline picker + debounce, streaming summarization + the raw-delta
caveat, the per-tab example-code mechanism with its glob trap, and the lint
wiring. The "`.test.ts` files are silently skipped" trap lane D hit is now
written down.

**Runtime pass — what was actually driven, and what was not.** A `vite dev`
server on :5177 was driven in a real browser: the Connection tab renders with its
example-code block (first file expanded, real source visible); Connect unlocks
both session tabs; the Live-transcription tab renders the audio-source panel
(four modes, `<Skeleton>` device placeholders, "Grant microphone access"), the
session/language/engine/recording cards, the metadata simulator, the two-track
timeline and the scorecard; the Summarization tab renders the full context form.
All three tabs load their own example-code block with no "Failed to load" state.
Both themes checked. axe scanned in both themes (result in §7). Every console
error was a network failure against the absent gateway (`/auth/me`,
`/tenant/me/config`, `/audio/transcription-jobs/language-modes`) — the degradation
paths behaved correctly (static language-mode fallback, free-text pipeline
picker). No React render errors.

**Not verified — needs live infra and hardware** (an honest list, not a hedge):

| Unverified | Needs |
|---|---|
| Any actual transcription, in any of the four audio modes | gateway :8868 + STT :8861 + a microphone / decodable audio file |
| The measured click→idle stop latency and the tail-final landing | the same, plus a stopwatch |
| `GET /api/v1/audio/pipelines` against a real tenant; the pipeline list state | a running gateway with a tenant SDK key (still open from lane E) |
| Mid-session pipeline↔default engine toggle | gateway + STT + a live session |
| Per-mic metadata actually round-tripping onto a returned transcript row | a live STT stream |
| Auto-tag firing off a real input level | a live microphone |
| Pre-summary / summary, streaming and non-streaming | gateway :8868 + SMR :8862 |
| Every finalize-touching STT integration suite | `pnpm setup:test` + live STT/API (already recorded by lane B-server; still true) |
| Mic-permission-dependent UI (device labels, multi-mic selection) | a browser session with granted microphone permission |

**Two corrections to the §8 record above.**

1. Lane B-server (and the lane G brief) attribute
   `test_asr_engines.py::TestP507WhisperCppEngine::test_adapter_contract` to *the
   staged* TASK-594 `whisper_cpp_asr.py` change. It is older than that: the test
   fails **identically with the `HEAD` copy of the file** (verified by swapping
   `git show HEAD:…whisper_cpp_asr.py` into place, running the single test, and
   restoring the working copy byte-identically). `git diff HEAD` on that file does
   not touch `split_on_word`, `max_len`, `token_timestamps` or
   `_want_word_timestamps` at all. Conclusion is unchanged — **not caused by
   TASK-597** — but the failure is already committed, so it will not disappear by
   unstaging.
2. Two verification commands in the plan do not exist. `pnpm py:stt:lint` was
   renamed to **`pnpm stt:lint`** by the TASK-557 script taxonomy, and `test:unit`
   is a **root** script, not a package one — `pnpm --filter @arcaai/api test:unit`
   fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`; the package suite is
   `pnpm --filter @arcaai/api test`.

**Open follow-ups (deliberately NOT implemented — owner decisions).**

1. **`finalizing` is inert on the v2 wire.** `parseAndEmitResult` relays only
   `provider_switched` among non-terminal statuses, so `finalizing` never reaches
   the browser. Lane B-server's early-resolve is correct and tested but pays off
   only once someone relays `finalizing` through `packages/applications` + the
   gateway. B3 makes `closed` arrive fast anyway.
2. **True per-mic auto-tag attribution** needs a per-source `AnalyserNode` in
   `AudioMixer`'s node graph. The SDK exposes one mixed-stream meter, so auto-tag
   rotates round-robin and says so in the UI. Scoped SDK change.
3. **`mlen_scorecard.py`'s `cer()` uses a `max(1, len(ref))` denominator**, so an
   empty reference returns the raw edit distance rather than a ratio
   (`cer('','hello') == 5`). The TS port reproduces it for parity. Decide whether
   such clips should score 5.0 or be excluded — a change here must land in both.
4. **Thread `drainTimeoutMs` through `AudioStartOptions`.** Lane B-server scoped
   it at client/provider level to avoid a file conflict with lane A.
5. ~~**`CodeExample`'s scrollable `<pre>` is not keyboard-focusable**~~ — ✅ **FIXED
   2026-08-01**, as its own `packages/ui` change. The `<pre>` now carries
   `tabIndex={0}` + `role="region"` + an `aria-label` derived from `title` and
   `language` (an unnamed focusable element announces nothing useful, so the name
   is part of the fix). Styling untouched — semantic tokens only.
   - 3 new CT tests in `code-example.test.tsx`, **RED-verified**: reverting the
     markup fails exactly those 3 while the 3 pre-existing a11y tests still pass.
   - `@arcaai/ui` build + lint clean; vitest **656 tests / 242 files**; component
     tests **17/17**.
   - Re-scanned in `apps/compat-playground` (axe-core 4.12.1, WCAG 2.0/2.1/2.2
     A+AA) with all 5 Connection-tab blocks expanded, **both themes**:
     `scrollable-region-focusable` **passes on 5/5 nodes**, 25 passes.
     §7 row 17's ⚠️ is discharged.

6. **NEW — stale text colour survives a theme change until the element repaints.**
   Found while re-scanning for #5. On a clean load in dark mode, axe reports 6
   serious `color-contrast` nodes at ~1.03–1.15 (config inputs, the selected tab
   trigger, an outline badge, a ghost button); toggling to light moves the failure
   to a *different* subset. Each element keeps ONE colour across toggles — e.g.
   `#config-pipelineId` computes `#e6edf0` (the dark foreground) on the light
   background.

   **The CSS is correct and this is not a token bug.** Proof: forcing a repaint
   (`display:none` → reflow → restore) while touching no CSS flips the element to
   the right colour, a fresh clone in the same parent renders correctly, and a
   whole-document forced repaint takes axe to **0 violations / 25 passes in both
   themes**. `--foreground` resolves correctly on the failing elements; the
   computed `color` is simply stale.

   Mechanism: the theme class is applied after first paint, and the affected
   controls carry `transition-[color,box-shadow]`, so the colour transition never
   runs for elements the browser does not repaint — they keep the previous theme's
   value. Real and user-visible (near-invisible input text), not merely an axe
   artifact.

   ⚠️ **Not attributed.** It reproduces on a clean load, but this ticket also made
   all three tab panels `forceMount`-hidden, which plausibly interacts with what
   does and does not repaint. Do **not** record it as pre-existing or as a TASK-597
   regression without bisecting. Likely fix sites: the app's `use-theme.ts` (apply
   the class before first paint), or dropping `color` from the transition on
   token-driven text in `@arcaai/ui`.

Ticket-number check discharged: `docs/archive/` was readable this session and
holds no `TASK-59*`; **597 is free**.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-01 | Ticket created. Review of the compat app, SDK compat layer, gateway compat modules, and the Python STT streaming path completed; findings A1–A5, S1–S5, D1–D3, G1–G2 recorded; 8-lane parallel plan with tier assignments drafted. |
| 2026-08-01 | Plan approved. Lane 0 executed and verified (barrier cleared). Lanes A, B-server, C, D, E, F dispatched in parallel with the three dispatch-time deviations recorded in §8. Lane B-client and lane G pending. |
| 2026-08-01 | Lane B-client (B1) complete — `stopAudio` teardown reordered ahead of the drain (+ in-flight guard), `StreamingBackendSTTProvider.destroy()` no longer awaits `closeSession()`, playground `stop()` reversed, `capture.phase` added and surfaced as a "Finalizing…" affordance. RED verified for both ordering changes; 12 new tests. Lane G pending. |
| 2026-08-01 | **Open follow-up #5 closed** — `CodeExample`'s scrollable `<pre>` made keyboard-focusable and named (`tabIndex={0}` + `role="region"` + `aria-label`) in `packages/ui`; 3 RED-verified CT tests added. `@arcaai/ui` build/lint clean, 656 vitest + 17 CT tests green; consumer re-scan shows `scrollable-region-focusable` passing 5/5 in both themes, discharging §7 row 17. **New follow-up #6 opened**: 6 serious `color-contrast` nodes traced to a stale computed `color` that survives a theme change until repaint — proven non-CSS (a forced repaint yields 0 violations in both themes); attribution deliberately left open pending a bisect against this ticket's `forceMount` change. |
| 2026-08-01 | **Lane G (final integration) complete.** R2 per-tab example code (`TabExampleCode`, glob-miss now rejects, RED-verified guard test); all five carried-forward fixes landed (mic/speaker badges, 400 ms pipeline-fetch debounce, scorecard `run.audioSource`, per-control `phase` decisions, ESLint wired with `compat:lint`/`compat:lint:fix`); app README rewritten for the three-tab console; §7 filled with evidence; ticket number confirmed free. Playground 173 tests / 15 files, vox 3771 / 221, api 2307, stt-pkg 429 — all green; typechecks, builds and lint clean. Known-pre-existing and reproduced at `HEAD`: 1 stt pytest failure + 1 mypy error. One axe violation, in `@arcaai/ui`'s `CodeExample`, recorded as an open follow-up. Status → `Review`. |
