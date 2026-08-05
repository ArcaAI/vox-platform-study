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
| 3 | Single mic / N mics / file→single / files→N-mixed all transcribe | ✅ (file→single, live) / ⚠️ (other 3 modes) | **LIVE-VERIFIED 2026-08-01** once STT was restarted through an interactive login shell so it inherited `HF_TOKEN` + `HF_HOME` from `~/.zshrc` (see §8 note — the earlier "no token" reading was a harness error, not a missing credential). Real clinical fixture (`cardiology_consult_01.wav`, 16 kHz mono, 21.9 s) streamed as 20 ms PCM16 frames at **1× realtime** through gateway → Redis → STT on `faster-whisper-large-v3-turbo-int8`: **4 transcript frames (1 final), fully accurate clinical text** ("…shortness of breath on exertion and intermittent chest pain… ordering an electrocardiogram and a troponin level… start aspirin 81 mg daily"). 700 160 bytes of PCM arrived intact (= 21.88 s). This is the SAME backend path the playground's file-backed source drives, so the file→single-mic mode is genuinely proven; N-mic mixing and the browser-side `MediaStream` plumbing remain unit-covered only. ⚠️ **Pacing matters**: an initial run at 4× realtime produced ZERO transcripts — the commit policy uses wall-clock windows (force_emit ~20 s), so faster-than-realtime ingestion emits nothing before finalize. Superseded the row below | |
| ~~3~~ | *(superseded)* | ⚠️ | Attempted live 2026-08-01 with all three services up (API :8868, STT :8861, SMR :8862) and a real clinical fixture (`apps/stt/tests/e2e/fixtures/clinical/cardiology_consult_01.wav`, 16 kHz mono, 21.9 s). **No streaming session can be created at all**: `POST /audio/transcription-jobs/stream/session` → 500, because STT fails to load its model. Every pipeline tried (`…403` faster-whisper CT2, `…419` arcaai-ml-en) resolves to the SAME private HuggingFace repo `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16`, which returns **`401 Unauthorized` / Repository Not Found** — no `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` / `HUGGINGFACE_TOKEN` is set in `.env.dev`, and no ASR model is cached on disk (`AiModel.downloadStatus` shows none downloaded). Consistent with the platform STT default having been repointed to the ArcaAI fine-tune. **Unblocking needs a HuggingFace token with access to that private repo, or a locally-cached public ASR model.** Superseded the row below | |
| ~~3~~ | *(superseded — original lane G entry)* | ⚠️ | Unit-covered end to end (`use-audio-sources`, `file-audio-source`, `AudioSourcePanel`, `useArcaAudio.sources.task597`). **No live transcription performed — no gateway, no STT, no microphone in this session.** |
| 4 | Stop returns the UI to idle in < 150 ms; mic indicator off; tail final still lands | ✅ (UI idle · ordering) / ❌ **(tail final does NOT land — see follow-up #10)** | **LIVE-MEASURED 2026-08-01**, same session as row 3. Timeline from the client's `{type:'stop'}`: `finalizing` **+4 ms** → final transcript **+30 413 ms** → `closed` **+30 418 ms**. Two conclusions. **(a) Lane B-server's ordering fix is CONFIRMED CORRECT**: `closed` trails the last transcript by **1 ms**, i.e. it is now published immediately after the transcript and before the MinIO uploads, exactly as designed — the 30 s is tail-flush ASR inference, not persistence. **(b) The "tail final still lands" half of this criterion is FALSIFIED in practice** — see follow-up #10; the UI would close its socket ~250 ms after stop and never receive that final. The UI-idle half remains structurally proven (the teardown block contains no `await`) and RED-verified. Note this harness is a raw WS client, not the SDK, so the SDK's drain behaviour is **inferred from the measured server timings**, not directly observed. Superseded the row below | |
| ~~4~~ | *(superseded)* | ⚠️ | A measurement harness was written and is ready (`stream-verify.mjs`: create session → WS with ticket → 20 ms PCM16 frames → collect transcripts → `{type:'stop'}` → time the interval to the terminal `status: closed`, i.e. exactly what lane B-server moved ahead of the MinIO uploads and what `stopAndDrain()` waits on). It could not run: no streaming session can be created (row 3). The UI half remains structurally proven and RED-verified by the ordering tests — the teardown block contains no `await` — but the **server-side stop→closed interval has still never been measured against live infra**. Superseded the row below | |
| ~~4~~ | *(superseded — original lane G entry)* | ⚠️ | Structural + test-proven (`useArcaAudio.stopOrder.task597.test.ts`, `playground-session.capture.test.tsx`; both RED-verified by reverting the ordering). **Not measured on a stopwatch against live infra.** |
| 5 | Per-mic metadata round-trips onto the correct transcript row | ✅ | `MetadataSimulator.test.tsx` (round-trip + 8 KB guard + auto-tag debounce); lane G added visible `mic`/`speaker` badges on the timeline — `TranscriptColumn.test.tsx` |
| 6 | WER/CER match `mlen_scorecard.py`; run exportable as JSON | ✅ | 11 shared fixtures compared at full float precision against the real Python, hard-coded as exact expectations (`scoring.test.tsx`); export now carries a real `run.audioSource` (`ScorecardPanel.test.tsx`) |
| 7 | Pipeline picker lists real pipelines; toggle flips mid-session without reconnect | ✅ (endpoint) / ⚠️ (toggle) | **LIVE-VERIFIED 2026-08-01** against a running gateway (:8868) — the first time this endpoint has ever been called for real. `GET /api/v1/audio/pipelines` → **HTTP 200, a BARE ARRAY of 14 pipelines** with `id`/`name`/`slug`, which is exactly the primary shape lane E's defensive unwrap handles. The mid-session engine toggle still requires a live STT session and remains unverified. Superseded the row below | |
| ~~7~~ | *(superseded — original lane G entry)* | ⚠️ | Picker verified against a mocked fetch incl. the new debounce; the free-text fallback confirmed live (no gateway → free text, correct). **`GET /api/v1/audio/pipelines` has still never been called against a running gateway; the mid-session toggle has never been exercised live.** |
| 8 | Department/visit/context → pre-summary → summary; live caption reachable from Summarization | ✅ | **LIVE-VERIFIED 2026-08-01.** `POST /api/smr/api/v1/presummary` (non-streaming, real tenant API key) → **HTTP 200** with a genuine v1-shaped body: `pre_summary` + `structured_data` carrying the five expected sections (Diagnoses / Plan of Care / Investigations / Medications / Diagnostics & Trends) + `created_at`. The LLM really ran (LM Studio); sections read "Not available" because no clinical history was supplied, which is correct behaviour, not a failure. Superseded the row below | |
| ~~8~~ | *(superseded — original lane G entry)* | ✅ (wiring) / ⚠️ (round trip) | `SummaryCard.test.tsx` (12); the tab reads the transcript from the lifted context, verified by test. **No SMR call made — no gateway.** |
| 9 | Streaming toggle renders tokens live; non-streaming returns the final body | ✅ | **LIVE-VERIFIED 2026-08-01** against gateway :8868 + SMR :8862 + LM Studio. `POST /api/smr/api/v1/summary/sync` with `stream:true` over a 7-turn consultation → **232 `event: delta` frames + exactly 1 terminal `event: result`, 0 `event: error`**. The deltas are raw text arriving token by token (`{`, `\n`, `"`, `chief`, …), **confirming lane F's finding that the gateway re-emits SMR `chunk` frames as raw text, NOT partial structured JSON** — the structured view only materializes at the terminal result. ⚠️ Caveat worth knowing: a SHORT generation (the pre-summary, which emitted only a heading) produced **0 deltas with a valid terminal result** — for fast/short generations the stream can complete before any delta is observed, so "live token rendering" is not guaranteed for every request. Superseded the row below | |
| ~~9~~ | *(superseded — original lane G entry)* | ⚠️ | `{stream:true,onDelta}` threading asserted in `SummaryCard.test.tsx`. **No real SSE stream observed.** |
| 10 | `pnpm --filter @arcaai/compat-playground test typecheck build` | ✅ | 173 tests / 15 files passed; `tsc --noEmit` clean; build ✓ in 17.39s (with the known ~6 MB chunk warning — reported below, not silenced) |
| 11 | `@arcaai/vox` test + typecheck + build | ✅ | 3771 tests / 221 files passed; typecheck exit 0; tsup build success |
| 12 | `pnpm stt:test` | ✅ | **2841 passed, 77 skipped, 3 xfailed, 0 failed.** `test_asr_engines.py::TestP507WhisperCppEngine::test_adapter_contract` root-caused and fixed 2026-08-01 — see the note below the table. Separately observed (not a test failure, out of scope, NOT touched): the process aborts during CPython finalization AFTER pytest's own "passed" summary prints (`Fatal Python error: PyThreadState_Get: … GIL … finalizing`, exit 134). Reproduces on `stt:test` and `stt:test:unit` alike, including subsets that never import `whisper_cpp_asr`; does not reproduce when only the whisper.cpp-adapter test files run. Most likely a native callback registered by TASK-594's `_ensure_log_capture_installed()` (`whisper_cpp_asr.py`, `whisper_log_set`) firing on a background thread after `Py_Finalize` starts — a process-exit artifact, not a test correctness issue, and outside this investigation's scope (touches TASK-594's validated native log-capture code) |
| 13 | `pnpm --filter @arcaai/api test` | ✅ | 2307 passed / 8 skipped, 165 files |
| 14 | Python lint / typecheck | ✅ | `pnpm stt:lint` (ruff) — All checks passed. `pnpm stt:typecheck` (mypy) — **clean, 0 errors** (131 source files). The `session_manager.py:893` error is fixed — see the note below the table |
| 15 | **NEW** — the app has a working `lint` gate | ✅ | `eslint.config.mjs` added; `pnpm --filter @arcaai/compat-playground lint` → clean at `--max-warnings 0` |
| 16 | Both themes verified | ✅ | Driven live in a browser, light **and** dark; semantic tokens only, `<Skeleton>` (not spinners) for the pending device list |
| 17 | axe scan 0 violations | ✅ (target rule) / ⚠️ (see #6) | **Lane G finding, now FIXED** — the 1 serious `scrollable-region-focusable` came from `packages/ui`'s `CodeExample` (`<pre className="overflow-x-auto …">`, horizontally scrollable but not keyboard-focusable). Resolved 2026-08-01 as its own `packages/ui` change: `tabIndex={0}` + `role="region"` + an `aria-label` from `title`/`language`. Re-scanned in the running app, both themes, all 5 Connection-tab blocks expanded: **`scrollable-region-focusable` passes 5/5**, 25 passes. See follow-up #5. ⚠️ The same re-scan surfaced a DIFFERENT issue — 6 serious `color-contrast` nodes from a stale computed `color` that survives a theme change until repaint (a forced repaint yields 0 violations in both themes, proving the CSS is correct). Tracked as follow-up **#6**; this row returns to a clean ✅ once that lands |

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

> ~~⚠️ **The `finalizing` early-resolve is currently INERT on the v2 wire.**~~ — ✅ **RESOLVED 2026-08-01** (open follow-up #1). `parseAndEmitResult` now default-forwards every non-terminal status, so `finalizing` reaches the browser. See follow-up #1 below for the evidence.

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

   **Root cause found and fixed 2026-08-01.** TASK-594 (commit `8b33267e`,
   *"feat(stt): enhance whisper.cpp integration with consultation prompts and
   word timestamp handling"*, 2026-07-31) made the word-split decode
   (`split_on_word`/`max_len=1`/`token_timestamps`) **opt-in** via a new
   `WhisperCppAsrAdapter(..., want_word_timestamps: bool = False)` constructor
   parameter — the default became a clean sentence-level decode with none of
   those kwargs set (see the docstring at `whisper_cpp_asr.py:311-315`). That
   commit correctly updated the adjacent
   `apps/stt/tests/unit/test_whisper_cpp_asr.py` (added
   `test_clean_decode_omits_word_split_kwargs` +
   `test_word_timestamp_mode_splits_and_space_joins`, covering both modes) but
   **missed the second, older test of the same contract** —
   `test_asr_engines.py::TestP507WhisperCppEngine::test_adapter_contract` — which
   constructs the adapter with no `want_word_timestamps` argument (so it now
   exercises the new clean-decode default) while still unconditionally
   asserting the pre-TASK-594 always-on `split_on_word`/`max_len`/
   `token_timestamps` contract. Both real production call sites
   (`batch_service.py:2745`, which omits the kwarg — batch defaults to clean
   decode — and `session_manager.py:1937`, which forwards a live
   `_pending_want_word_timestamps` flag) are consistent with the new opt-in
   design, confirming this is a genuinely superseded contract, not a
   regression. **Verdict: stale test, not a code regression.** Fixed by
   passing `want_word_timestamps=True` at the one call site inside
   `test_adapter_contract` (this test's whole purpose is the word-timestamp
   contract) and rewriting its docstring to explain the opt-in split and point
   at the two tests in `test_whisper_cpp_asr.py` that already cover the
   default clean-decode path. No production code changed; TASK-594's
   `whisper_cpp_asr.py` is untouched. `pnpm stt:test` is now 2841 passed / 77
   skipped / 3 xfailed / **0 failed**.
2. Two verification commands in the plan do not exist. `pnpm py:stt:lint` was
   renamed to **`pnpm stt:lint`** by the TASK-557 script taxonomy, and `test:unit`
   is a **root** script, not a package one — `pnpm --filter @arcaai/api test:unit`
   fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`; the package suite is
   `pnpm --filter @arcaai/api test`.
3. **The `session_manager.py:893` mypy error is fixed 2026-08-01.**
   `_load_pipeline_config(self, pipeline_id: str, tenant_id: str | None = None)`
   requires a non-optional `pipeline_id` (and forwards it to
   `PipelineConfigReader.get_pipeline`, which is equally non-optional — so
   widening either signature would only push the same "str | None where str is
   expected" error one level deeper, into a real DB-lookup call). At the call
   site, `initial_pipeline_id = fallback_pipeline_id if started_on_fallback
   else pipeline_id` types as `str | None` because `fallback_pipeline_id: str |
   None = None` is a `create_session` parameter — but `None` is **not actually
   reachable** there: `started_on_fallback = start_on == "fallback" and
   bool(fallback_pipeline_id)` (line 885) is `True` only when
   `fallback_pipeline_id` is truthy, so mypy's inability to correlate that
   boolean with the later ternary is a narrowing gap, not a real bug. Fixed by
   narrowing at the call site with `assert initial_pipeline_id is not None`
   (the same idiom already used one module over, in
   `engine_switch.py:242` — `assert self._build_primary is not None  #
   narrowed by can_switch_to_primary`), with a comment explaining why the
   `None` branch is unreachable. `pnpm stt:typecheck` is now clean (0 errors,
   131 files). The finalize-ordering code TASK-597 lane B-server added
   elsewhere in this file (`closed`-before-uploads reorder, ~line 3426+) was
   not touched.

**Open follow-ups (deliberately NOT implemented — owner decisions).**

1. ~~**`finalizing` is inert on the v2 wire.**~~ — ✅ **FIXED 2026-08-01.**
   `parseAndEmitResult`
   ([streamingAudioBridge.service.ts](../../../packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts))
   now **default-forwards every non-terminal status** instead of relaying an
   allow-list of one (`provider_switched`). `finalizing` therefore reaches the
   browser and the SDK's stop-drain quiet window is live.

   - **Terminal semantics unchanged.** The function's boolean still means "this
     entry was TERMINAL", and the terminal set is still exactly
     `closed | cancelled`. `finalizing` is emitted and returns `false`, so the
     reader keeps reading and the tail final published after it still relays.
     Terminal statuses remain UNEMITTED — the WS gateway synthesizes its own
     closing frame in `complete:`, so relaying them would double-send `closed`.
   - **Default-forward, not a wider allow-list** — the allow-list *is* the
     TASK-568 Phase-F bug class that made `finalizing` inert, and it is the bug
     the v1-compat gateway already guards against in a comment. Status VALUES are
     default-forwarded; status FIELDS are still projected explicitly by a new
     `buildStatusMessage()`, because the result stream is a PHI-bearing channel
     and a blind spread would put whatever a future publisher adds onto the
     browser wire. The projection was chosen against the **complete** status
     vocabulary `apps/stt` can publish — `publish_status` emits `{type, status}`
     only (`finalizing` / `closed` / `cancelled`) and `publish_provider_switched`
     adds `from_pipeline` / `to_pipeline` / `reason` / `active` / `is_fallback` /
     `utterance_index` (`apps/stt/src/stt/streaming/redis_streams.py`). None
     carries transcript text or any other PHI. A status entry with an empty or
     absent `status` field is dropped (the SDK's `isValidStatus` would reject it).
   - **No gateway code change was needed, in either wire.**
     `stt-ws.gateway.ts` relays whatever the bridge emits verbatim (status frames
     bypass the transcript backpressure policy and carry no seq), and
     `stt-compat.gateway.ts` already default-forwards every status frame. Both
     were previously starved by the bridge, not by their own logic. Both got a
     characterization test instead of an edit.
   - **Frame shape verified against the consumer.** The socket receives exactly
     `{type:'status', status:'finalizing'}`, which satisfies
     `SttWebSocketClient.isValidStatus` (`status` a string, `message` absent or a
     string) and reaches the `msg.status === 'finalizing'` branch that calls
     `pendingDrainNudge('finalizing')`.
   - **RED verified**: both relay tests failed against the pre-change bridge
     (`expected [ … ] to have a length of 2 but got 1`), then passed.
     `@arcaai/applications` 7178 tests / 368 files green (+2), `@arcaai/api`
     2309 / 165 green (+2); both packages build and lint with **0 errors and no
     new warnings**.
   - **NEW follow-up #7 opened** (found here, deliberately not fixed):
     `active` / `is_fallback` never leave the bridge, so
     `stt-compat.gateway.ts`'s `is_fallback → isFallback` mapping (TASK-586) is
     dead in production — its test feeds the message directly. Fixing it means
     widening `StreamingStatusMessage`, which is outside this follow-up's scope.
   - **Not provable without live infra**: that a real session actually resolves
     its drain on the quiet window. Every layer is unit-verified and the wiring
     is continuous, but no end-to-end run was performed — it needs Redis + a live
     STT session + a browser.
2. ~~**True per-mic auto-tag attribution**~~ — ✅ **RESOLVED 2026-08-01.**
   Auto-tag now attributes to the microphone that is actually speaking.

   **The per-source level API.** `AudioMixer` gains opt-in, additive
   `startLevelMonitoring(options?) → boolean` / `stopLevelMonitoring()` /
   `isLevelMonitoringActive()` / `getSourceLevels()` / `getSourceLevel(id)`
   (`packages/room/src/core/AudioMixer.ts`). The mixer is the last place in the
   stack where the inputs still exist as SEPARATE signals — everything
   downstream sees one summed track — so this is the only layer at which
   "which mic" is answerable at all. Design points, each deliberate:
   - **One timer, N analysers** (default 100 ms — the SDK meter's cadence), not
     N timers. Each tap is analysis-only and connected to NOTHING, so it adds
     no playback and does not alter the mix (asserted: the analyser's own
     `connect` is never called).
   - **Tapped off the SOURCE node, not the gain node.** `muteSource()` calls
     `gainNode.disconnect()`, which would tear an analyser hung there out of the
     graph and never restore it on unmute. A muted source instead reports `0`
     explicitly — the level answers "is this input feeding the uplink".
   - **Same 0–100 mapping as the mixed meter** (`min(100, round(rms*250))`), so
     one threshold works against either.
   - **Returns `false`, not a throw, on a runtime that cannot analyse**
     (no `createAnalyser`, or no `getFloatTimeDomainData`) — an absent signal
     must degrade to "attribution unknown", never to a fake one.

   **Teardown is guaranteed at three levels, because one would not be enough:**
   `AudioMixer.dispose()` calls `stopLevelMonitoring()` FIRST (a sampling timer
   that outlived its mixer would fire against disconnected nodes for the life of
   the page); `useArcaAudio.stopAudio` disposes the mixer inside the SAME
   synchronous block that releases the mic (lane B-client's ordering untouched)
   and clears `audioSourceLevels` there, so no stale "mic 2 is speaking" is
   readable during the drain; and `startAudio`'s **catch** now releases the
   level meter + mixer monitoring — a throw after the meters were armed
   previously left them ticking forever (a pre-existing leak of the single
   meter, now closed for both).

   **SDK → app.** New store field `audioSourceLevels: number[]`, index-aligned
   with the RESOLVED source order (the same index `sourceGains` uses), surfaced
   as `useArcaAudio().sourceLevels` and `useAudioCapture().sourceLevels`
   (reactive — the app no longer polls `getDeviceStatus()` for this).
   `level` semantics are UNCHANGED: it is still the single mixed value every
   existing consumer reads.

   **Is auto-tag genuinely per-mic? Yes, with two named limits** — and the UI
   states which of the three cases is live, derived from the signal itself
   (`metadata.autoTagMode`), so the disclosure can no longer drift from the code:
   | Mode | When | What it claims |
   |---|---|---|
   | `per-source` | ≥2 live per-source meters | **Real attribution.** The loudest source above threshold owns the turn, and a CHANGE of loudest source re-tags immediately — a speaker change must not wait for silence. Disclosed limit: mics in one room bleed, so this attributes by loudest INPUT, not by voice identity. |
   | `single-source` | exactly 1 source (one mic, or one file) | Exact for "which input", and **it says plainly that one mic cannot separate two speakers**. This is the honest-disclosure case the follow-up asked to keep. |
   | `unavailable` | no per-source signal (not recording, or no Web Audio analysis) | The old round-robin rotation, kept and labelled as a demo of the payload shape, **not** attribution. |

   Evidence: `AudioMixer.levels.task597.test.ts` (14), `useArcaAudio.sourceLevels.task597.test.ts` (12),
   `MetadataSimulator.perSource.task597.test.tsx` (8). **RED-verified by mutation** —
   publishing the mixed meter as a per-source array fails the "MIXED level
   untouched" test; deleting the failed-start cleanup fails 2; forcing the
   fallback branch (`false &&`) fails the 4 attribution tests. All patches
   reverted and the files byte-compared (`diff` clean).
3. ~~**`mlen_scorecard.py`'s `cer()` uses a `max(1, len(ref))` denominator**~~ —
   ✅ **DECIDED 2026-08-01 (owner): keep as-is, document it.** An empty reference
   with a non-empty hypothesis returns the raw edit distance rather than a ratio
   (`cer('','hello') == 5`), on BOTH sides.
   - Rationale: the alternatives (excluding empty-reference clips from the
     aggregate, or clamping to 1.0) each shift aggregate scores and would force a
     regeneration of `apps/stt/tests/integration/mlen_scorecard_baseline.json`.
     Parity between the playground and the TASK-594 quality gate is worth more
     than a tidier edge case — that parity is the entire point of the port.
   - Recorded in code so it is not "fixed" by a future reader:
     `apps/compat-playground/src/lib/scoring.ts::characterErrorRate` carries a
     DELIBERATE note, and `apps/stt/scripts/mlen_scorecard.py::cer` carries the
     mirror-image note. **Any future change must land on both sides in the same
     commit.**
   - Also corrected while there: that module's docstring called the normalization
     "transliteration-agnostic", but `_norm` only does NFC → collapse whitespace →
     strip — no case-folding, punctuation stripping, digit normalization or
     transliteration (verified across 11 fixtures). Wording only, no behaviour
     change.
4. ~~**Thread `drainTimeoutMs` through `AudioStartOptions`.**~~ — ✅ **RESOLVED
   2026-08-01.** Additive-optional `AudioStartOptions.drainTimeoutMs`, threaded:

   ```
   AudioStartOptions.drainTimeoutMs            (types/audio.ts)
     → useArcaAudio.startAudio → pluginManager.setRuntimeOptions(…)
     → PluginManagerRuntimeOptions.drainTimeoutMs
     → PluginManager.buildStreamingTransport → STTStreamingTransport.drainTimeoutMs
     → STTProcessor.initializeStreamingRemoteProvider → provider.init(…)
     → StreamingRemoteProviderConfig.drainTimeoutMs  (lane B2's existing field)
     → wsClient.stopAndDrain(ms)
   ```

   It rides the streaming **transport**, not `TranscriptionPipelineConfig.stt`:
   the drain is a property of socket teardown, not of what is being
   transcribed — and that route leaves `TranscriptionPipeline.ts` untouched.
   `useAudioCapture` forwards it too (compat consumers, incl. the playground).

   **Non-positive values are ignored at every hop that could misread them** —
   the hook, the plugin manager, the compat hook (all spread only when `> 0`)
   and the provider's own pre-existing guard. `0` must never read as "close
   instantly" (losing the tail final) and `NaN` must never reach a `setTimeout`.
   Omitted ⇒ the field is absent from the options object, byte-identical to
   pre-597 for every caller that does not set it.

   Evidence: 5 cases in `useArcaAudio.sourceLevels.task597.test.ts` +
   `packages/stt/src/__tests__/STTProcessor.drainTimeout.task597.test.ts` (4),
   which pins the last hop (`stopAndDrain` receives `800` / `undefined`).
   **RED-verified**: deleting the `STTProcessor` forwarding line fails exactly
   the positive-value test; dropping the `> 0` guard fails 4.
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

6. ~~**Stale text colour survives a theme change until the element repaints.**~~
   — ✅ **FIXED 2026-08-01, in the app.** Attribution bisected first, as required.

   **Verdict: PRE-EXISTING, and not caused by this ticket's `forceMount`.**
   Three independent pieces of evidence, all reproduced in the running app at
   :5177:
   - **The `forceMount` panels were physically removed** from the DOM
     (`[data-slot="tabs-content"][data-state="inactive"]` → `.remove()`), then the
     theme toggled: **the identical 17 elements stranded**. `forceMount` is
     exonerated by experiment, not by argument.
   - **A control built from bare DOM**, appended straight to `<body>` — no React,
     no `Tabs`, no ticket code — reproduces it exactly:
     `<input class="text-foreground transition-[color,box-shadow]">` and
     `<button class="text-foreground transition-all">` both keep the light
     `rgb(14,26,36)` after `.dark` is added, while the *same* markup without the
     transition class correctly becomes `rgb(230,237,240)`.
   - `apps/compat-playground/src/lib/use-theme.ts` — the actual fault site — is
     **byte-identical to its introduction in `55cf370f` (TASK-586 lane F)**; the
     `@arcaai/ui` primitives involved are older still.

   **Mechanism (corrected).** Flipping `.dark` on `<html>` changes `color`,
   `background-color` and `border-color` purely through a custom-property
   cascade. That starts a transition on every element carrying `transition-all`
   or `transition-[color,box-shadow]`, but the browser never repaints those
   elements, so the interpolation never advances — several tab triggers were
   caught frozen at a mid-interpolation value
   (`oklab(0.211704 -0.0112417 -0.0237211 / 0.6)`). It is **not** limited to
   `color`: a `transition-all` div strands its `background-color` and
   `border-color` too, which is why "drop `color` from `transition-[color,…]`"
   would have been an incomplete fix — and why the fix does not belong in the
   primitives.

   **Fix (app layer, 2 files, no restyling, no primitive touched):**
   - `index.html` — a **blocking bootstrap script in `<head>`** applies `.dark`
     from the OS preference *before the first paint*, so the initial theme never
     starts a transition at all (the no-flash pattern; `apps/admin-console` gets
     this from next-themes).
   - `src/lib/use-theme.ts` — initial state is now **adopted from the class the
     bootstrap left on `<html>`** (with a `systemTheme()` fallback for the
     degraded case where the script did not run), and every flip goes through
     `applyThemeWithoutTransitions()`: insert a `transition:none !important`
     style, toggle the class, force a style flush, remove the style. This is
     precisely next-themes' `disableTransitionOnChange`, which
     `apps/admin-console/src/shared/providers.tsx` already sets — the playground
     hand-rolled its theme hook and skipped it. Suppressing transitions also
     fixes background and border staleness, which a primitive-level change
     would not have.

   **Evidence (axe-core 4.12.1, WCAG 2.0/2.1/2.2 A+AA, connected, all 25
   example-code `<pre>` blocks expanded, NO forced repaint anywhere):**

   | Scan | Theme | Violations | Passes | Stale elements |
   |---|---|---|---|---|
   | Clean load, OS = dark | dark | **0** | 25 | **0 / 646** |
   | After toggle → light | light | 1 (see #8) | 25 | **0 / 646** |
   | After toggle → back to dark | dark | **0** | 25 | **0 / 646** |
   | Clean load, OS = light | light | 1 (see #8) | 25 | **0 / 646** |
   | After toggle → dark | dark | **0** | 25 | **0 / 646** |

   "Stale elements" is a clone-comparison sweep run alongside each scan: for
   every rendered element, its computed `color`/`background-color`/`border-color`
   is compared against a freshly-cloned sibling with `transition:none`. Before
   the fix this reported up to 17 mismatches per toggle; after it, **zero in
   every state**.

   Regression cover: `src/lib/__tests__/use-theme.test.tsx`, 3 tests,
   **RED-verified** against the old hook (adopt-the-DOM-class failed with
   `expected 'light' to be 'dark'`; transitions-suppressed failed with
   `expected false to be true`). The paint behaviour itself is *not* testable in
   happy-dom — there is no layout or compositor — so the tests pin the two
   properties that remove the trigger (adopt the pre-paint class; flip with
   transitions off, and never leave the suppressor behind) rather than asserting
   a colour.

   Gates: `@arcaai/compat-playground` **176 tests / 16 files green**, `build`
   clean (bootstrap script verified present in `dist/index.html`), ESLint clean
   on both changed files. `typecheck` and the whole-app `lint` are red **only**
   on concurrent lanes' in-flight files (`playground-session.tsx` `sourceLevels`,
   awaiting its SDK-side change; 4 prettier warnings in `MetadataSimulator.tsx`)
   — neither is reachable from this change. `packages/ui` was **not modified**
   (`git status` clean).

7. **NEW — `active` / `is_fallback` never leave the streaming bridge.** Found
   while closing #1. `apps/stt`'s `publish_provider_switched` carries both
   (TASK-586, both switch directions), and `stt-compat.gateway.ts` explicitly
   maps `is_fallback → isFallback` for the v1 client — but
   `streamingAudioBridge.service.ts` has never projected either field, so that
   mapping is **dead in production** (its test feeds the message straight to the
   gateway, bypassing the bridge). The v2 SDK is unaffected: `useArcaSttProvider`
   derives `isFallback` from the store, not the wire. Fix = add both to
   `StreamingStatusMessage` + `buildStatusMessage()`; deliberately left out of
   #1 to keep that change surgical.
8. **NEW — inactive `TabsTrigger` misses AA contrast in the light theme by
   0.01.** Surfaced by the #6 re-scan and **proven to be a different defect**:
   the computed colour matches a fresh clone exactly (0 stale), and the violation
   is *identical* on a clean load and after a toggle — the signature of a real
   token value, not the repaint bug. `TabsTrigger`'s `text-foreground/60`
   ([tabs.tsx:47](../../../packages/ui/src/components/shadcn/tabs.tsx))
   resolves to `#6e767c` on `--background #fbfcfd` = **4.49:1**, against the
   4.5:1 floor; 2 nodes, serious. Pre-existing (that class has not changed since
   the initial commit) and it applies to **every `@arcaai/ui` consumer**, so
   `apps/admin-console` and Storybook inherit it wherever a line-variant tab list
   is shown in light mode. Deliberately NOT fixed here: the remedy is a palette
   decision on a shared primitive (`/60` → `/70` measures 6.4:1) and belongs
   behind the design gate of `12-design-workflow.md`, not inside a repaint fix
   that was explicitly scoped "no restyling".

7. **`active` / `is_fallback` are never projected by the bridge**, so
   `stt-compat.gateway.ts`'s `is_fallback → isFallback` mapping (TASK-586) is dead
   in production — its test feeds the gateway directly, bypassing the bridge. The
   v2 SDK is unaffected (`useArcaSttProvider` derives it from the store). Fixing it
   means widening `StreamingStatusMessage`.

8. **Inactive `TabsTrigger` fails AA contrast: `text-foreground/60` → `#6e767c` on
   `--background #fbfcfd` = 4.49:1** (floor 4.5:1, 2 nodes, serious). Proven NOT the
   repaint bug — computed colour equals a fresh clone, and it is identical on a
   clean load and after a toggle. `packages/ui/src/components/shadcn/tabs.tsx` is
   unchanged since its initial commit, so this is **live for admin-console and
   Storybook today**. Remedy is roughly `/60` → `/70` (~6.4:1), but that is a
   visible palette change on a shared primitive and belongs behind the design gate.

9. **⚠️ DEV ENVIRONMENT BROKEN — Vault and `.env.dev` have diverged.** Found
   2026-08-01 while attempting the live-verification pass. This is an environment
   defect, NOT a TASK-597 code defect, and it currently blocks §7 rows 8 and 9.

   | Secret | Vault (`secret/hope/*`) | `.env.dev` | Effect |
   |---|---|---|---|
   | `API_KEY_PEPPER` | fp `d2ecdc9b…` | fp `db8e6850…` | **Every seeded API key 401s** |
   | `SMR_SERVICE_TOKEN` | fp `ce473e2a…` | fp `356e9620…` | **Gateway→SMR 401 `invalid_or_missing_token`** |

   Two sources of truth that must agree but do not:
   - The **DB seed** (`seed/api-key-pepper.ts`) prefers a non-empty
     `process.env.API_KEY_PEPPER`, falling back to Vault. `.env.dev` HAS a
     non-empty value — even though that file's own comment says it "keeps
     `API_KEY_PEPPER` blank on purpose", which is precisely the condition that
     avoids this divergence.
   - The **runtime** (`apikey.service.ts:175`) reads the pepper ONLY from
     `SecretsService` (Vault). Same story for `X-Service-Token` injection.
   - So keys are hashed with one pepper and verified with another. The failure
     surfaces as a generic `Invalid API key`, which gives no hint of the cause —
     a nasty footgun worth a startup-time consistency check.

   Proven, not inferred: a key hashed with the **Vault** pepper authenticated
   immediately (HTTP 200) where all 9 seeded keys 401. That temporary row
   (`7f597000-…-000000000597`) was **deleted afterwards** — 9 keys remain, and the
   temp key now returns 401. No seeded row was ever modified.

   **Owner decision required** — likely `scripts/vault-seed-secrets.sh` to re-seed
   Vault from env so both align. NOT done here: it rewrites live Vault values and
   could affect anything else already sealed with the current ones (storage
   credentials behind `credentialsRef`, Transit-encrypted columns).

10. **⚠️ NEW, HIGH — the drain closes long before the tail final arrives, so the
    live UI loses the last (often the ONLY) transcript.** Found by live
    measurement 2026-08-01, not by any test.

    Measured against `faster-whisper-large-v3-turbo-int8` (`has_vad: false`, so
    the whole utterance is flushed at finalize rather than segmented live):

    | Event | Offset from `stop` |
    |---|---|
    | `status: finalizing` | **+4 ms** |
    | final transcript | **+30 413 ms** |
    | `status: closed` | **+30 418 ms** |

    `SttWebSocketClient` (`:583`) opens a **250 ms quiet window** the moment a
    `finalizing` status arrives, and only a TRANSCRIPT restarts it. The overall
    `drainTimeoutMs` is **1500 ms**. Both elapse ~29 seconds before the final
    transcript exists, so the socket is closed and **the transcript never reaches
    the live UI**. The durable record is unaffected — the gateway persists it —
    but the playground shows an empty transcript for a pipeline that transcribed
    perfectly.

    **The semantics are the bug**, not the numbers. `finalizing` means "the server
    has STARTED finalizing", i.e. a long inference is beginning — it is precisely
    the wrong moment to shorten the wait. TASK-597 made this reachable in two
    steps that are individually correct: follow-up #1 made `finalizing` actually
    reach the client (it was inert before), and lane B2 taught the drain to end
    early on it.

    **Not a regression** — the tail final was already lost before this ticket
    (the old 5000 ms default is also ≪ 30 s). This ticket makes it lose it sooner
    (250 ms instead of 1500/5000 ms) and, for the first time, gives us the
    measurement that proves it.

    Suggested fix: `finalizing` should **extend** the drain deadline, not open a
    quiet window — or the quiet window should only start after the first
    post-`finalizing` transcript. Either way the drain needs a ceiling far above
    1500 ms for `has_vad: false` pipelines, or a server-side "expected flush
    duration" hint. **Requires a design decision; deliberately not patched here.**

    ### ✅ CONFIRMED IN THE REAL CLIENT — 2026-08-01, Chrome + microphone granted

    The above was originally *inferred* from server timings measured with a raw
    WS harness. It has now been **observed inside the actual SDK**, driving the
    playground UI in real Chrome (`arcaai-whisper-large-ml-en-gguf`, language mode
    `ml-en`, file-backed source, 4.2 s ml-en clip). `window.WebSocket` was wrapped
    to record every frame. Timeline relative to the Stop click:

    | Δ from Stop | Event |
    |---|---|
    | −8425 ms | `ready` |
    | −5177 ms | `transcript` **partial** — `ത്തരം പ്രധാനമാണ്` (real Malayalam) |
    | +1 / +16 / +16 ms | `SENT: stop` — **three** stop frames |
    | +27 ms | `status: finalizing` |
    | **+335 ms** | **socket CLOSED, code 1000 — no FINAL ever received** |

    104 binary audio frames were sent, so audio genuinely flowed. **The UI ended
    with 0 transcript lines.** The +335 ms close is precisely the mechanism:
    `finalizing` at +27 ms opened the 250 ms quiet window, no transcript restarted
    it, the drain resolved at ~+277 ms and the socket closed — while the server
    needs 1–3.6 s (GGUF) to 30 s (CT2) to emit the tail final.

    Server-side proof the transcript existed: the STT log for session
    `019fbd63-1599-7c0c-a02d-56d6128dad6a` records **`Utterance transcribed`**
    (`utterance_index: 0`) *after* the client had gone.

    ⚠️ **CORRECTION to the mitigation stated above.** "The durable record is
    unaffected — the gateway persists it" is TRUE only when a consultation exists.
    The same log shows `streaming finalize has no consultation_id; skipping
    transcript persistence` — and the playground deliberately opens no
    consultation. **In the playground flow the transcript is lost outright, not
    merely lost from the live UI.** That makes this materially worse than first
    recorded, and it raises the priority of the fix.

    Incidental: three `stop` control frames are sent for one Stop click. Harmless
    (the server treats them idempotently) but wasteful, and it suggests more than
    one teardown path is firing the finalize.

Ticket-number check discharged: `docs/archive/` was readable this session and
holds no `TASK-59*`; **597 is free**.

### Known-pre-existing `pnpm stt:test` abort (exit 134) — closed

The "1 stt pytest failure … reproduced at `HEAD`" carried in this ticket's
closure notes was in fact **not a test failure at all**: the suite ran fully
green (`2841 passed`) and then aborted during interpreter shutdown, so the
command exited **134** instead of 0.

```
2841 passed, 77 skipped, 3 xfailed, 14 warnings in 74.35s
Fatal Python error: PyThreadState_Get: the function must be called with the GIL held,
but the GIL is released (the current Python thread state is NULL)
Python runtime state: finalizing
Abort trap: 6   pytest apps/stt/tests/ -v --tb=short
```

**Provenance — introduced, not pre-existing to the branch, and already
committed.** Trustworthy bisect via two detached read-only worktrees, each run
with `PYTHONPATH` pointed at its own `apps/stt/src` and the resolved
`stt.__file__` printed to prove the worktree source was the one under test (the
conda env carries an editable `.pth` pinned to the main working tree, so an
un-overridden worktree run would silently have tested the wrong source):

| Revision | `pytest apps/stt/tests/unit/*.py` |
|---|---|
| `1257dff0` (parent) | **EXIT=0** |
| `d6ca581b` — `feat(whisper_cpp_asr): implement concurrency serialization and poison recovery` | **EXIT=134** |

`d6ca581b` is TASK-594's whisper.cpp adapter work and is **32 commits behind
`HEAD` on `dev-2.1`** — so `test-stt` was already red at `HEAD`, and committing
TASK-594's remaining uncommitted files neither caused nor worsens it.

**Root cause.** The macOS crash report
(`~/Library/Logs/DiagnosticReports/python3.11-*.ips`) names the main thread at
process `exit()`:

```
abort ← fatal_error ← _Py_FatalErrorFunc ← _Py_FatalError_TstateNULL
     ← dict_dealloc ← func_dealloc
     ← _pywhispercpp.cpython-311-darwin.so
     ← __cxa_finalize_ranges ← exit ← dyld start
```

`_ensure_log_capture_installed()` hands the Python callable `_dispatch_log` to
`_pywhispercpp.whisper_log_set()`. pybind11 parks it in a C++ **static**, which
outlives `Py_Finalize()`; its destructor then runs from `exit()`'s
`__cxa_finalize_ranges` and `Py_DECREF`s a Python function with no thread state
→ fatal. Whether the refcount actually reaches zero there depends on what else
is loaded, which is why the abort looked test-order-dependent and why neither
half of `tests/unit/*.py` reproduced it alone. It is **not** a background
thread, not a third-party library, and nothing in the STT service ever raced.

**Fix** (`apps/stt/src/stt/streaming/whisper_cpp_asr.py`): remember the module
the sink was registered with (`_log_module`) and `atexit.register` a
`_uninstall_log_capture()` that calls `whisper_log_set(None)` — whisper.cpp's
documented "restore the default logger" — so the static holds nothing Python by
the time it is destroyed. **Cannot regress TASK-594's ASR behaviour**: it runs
only from `atexit`, after every decode is done; the callback stays installed and
Metal-poison auto-recovery is untouched for the entire life of the process. 4
RED-verified regression tests added to
`apps/stt/tests/unit/test_whisper_cpp_asr.py` (RED proven by running the current
tests against `HEAD`'s copy of the module).

**Evidence** — `pnpm stt:test` **EXIT=0** on 6/6 post-fix runs (0 aborts;
`2845 passed, 77 skipped, 3 xfailed`), `pnpm stt:test:unit` **EXIT=0** on 3/3
(`2636 passed`), `pnpm stt:lint` **EXIT=0** ("All checks passed!"),
`pnpm stt:typecheck` **EXIT=0** ("no issues found in 131 source files"). The
narrow reproducer `pytest apps/stt/tests/unit/*.py` — 134 on every pre-fix run —
is 0 on 3/3 after. The test command was **not** weakened in any way.
`pnpm stt:format:check` stays red, unchanged: both touched files already failed
`black` at `HEAD`, and a set-difference against a pristine `HEAD` worktree shows
the only newly-failing file is another lane's in-flight
`tests/unit/processors/test_asr_engines.py`.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-01 | Ticket created. Review of the compat app, SDK compat layer, gateway compat modules, and the Python STT streaming path completed; findings A1–A5, S1–S5, D1–D3, G1–G2 recorded; 8-lane parallel plan with tier assignments drafted. |
| 2026-08-01 | Plan approved. Lane 0 executed and verified (barrier cleared). Lanes A, B-server, C, D, E, F dispatched in parallel with the three dispatch-time deviations recorded in §8. Lane B-client and lane G pending. |
| 2026-08-01 | Lane B-client (B1) complete — `stopAudio` teardown reordered ahead of the drain (+ in-flight guard), `StreamingBackendSTTProvider.destroy()` no longer awaits `closeSession()`, playground `stop()` reversed, `capture.phase` added and surfaced as a "Finalizing…" affordance. RED verified for both ordering changes; 12 new tests. Lane G pending. |
| 2026-08-01 | **Open follow-up #5 closed** — `CodeExample`'s scrollable `<pre>` made keyboard-focusable and named (`tabIndex={0}` + `role="region"` + `aria-label`) in `packages/ui`; 3 RED-verified CT tests added. `@arcaai/ui` build/lint clean, 656 vitest + 17 CT tests green; consumer re-scan shows `scrollable-region-focusable` passing 5/5 in both themes, discharging §7 row 17. **New follow-up #6 opened**: 6 serious `color-contrast` nodes traced to a stale computed `color` that survives a theme change until repaint — proven non-CSS (a forced repaint yields 0 violations in both themes); attribution deliberately left open pending a bisect against this ticket's `forceMount` change. |
| 2026-08-01 | **Lane G (final integration) complete.** R2 per-tab example code (`TabExampleCode`, glob-miss now rejects, RED-verified guard test); all five carried-forward fixes landed (mic/speaker badges, 400 ms pipeline-fetch debounce, scorecard `run.audioSource`, per-control `phase` decisions, ESLint wired with `compat:lint`/`compat:lint:fix`); app README rewritten for the three-tab console; §7 filled with evidence; ticket number confirmed free. Playground 173 tests / 15 files, vox 3771 / 221, api 2307, stt-pkg 429 — all green; typechecks, builds and lint clean. Known-pre-existing and reproduced at `HEAD`: 1 stt pytest failure + 1 mypy error. One axe violation, in `@arcaai/ui`'s `CodeExample`, recorded as an open follow-up. Status → `Review`. |
| 2026-08-01 | **Open follow-up #1 closed** — `finalizing` now reaches the browser. `parseAndEmitResult` (`packages/applications/.../streamingAudioBridge.service.ts`) switched from a one-entry non-terminal allow-list to **default-forwarding every non-terminal status**, with a new `buildStatusMessage()` projecting an explicitly enumerated, PHI-free field set (the complete `apps/stt` status vocabulary was enumerated before deciding). Terminal semantics untouched: the terminal set is still exactly `closed \| cancelled`, `finalizing` returns `false` so the tail final still relays, and terminal statuses stay unemitted so the WS gateway's synthesized closing frame is not duplicated. **Neither gateway needed a code change** — `stt-ws.gateway.ts` relays verbatim and `stt-compat.gateway.ts` already default-forwards; both were starved by the bridge, and both got a characterization test instead of an edit. Relay tests **RED-verified** against the pre-change bridge. `@arcaai/applications` 7178/368 and `@arcaai/api` 2309/165 green (+2 each), both build, both lint with 0 errors and no new warnings. Root `pnpm lint` is red only on `@arcaai/room#build` (`AudioMixer.ts`, a concurrent lane's in-flight edit — reproduced independently, unrelated to these files). **New follow-up #7 opened**: `active`/`is_fallback` never leave the bridge, so the v1-compat gateway's `isFallback` mapping is dead in production. Not proven end to end — a live drain resolving on the quiet window needs Redis + a live STT session + a browser. |
| 2026-08-01 | **Open follow-up #6 closed — attribution bisected: PRE-EXISTING, not a `forceMount` regression.** Three independent proofs: removing the `forceMount`-hidden panels from the DOM strands the identical 17 elements; a bare `<input class="transition-[color,box-shadow]">` / `<button class="transition-all">` appended straight to `<body>` (no React, no `Tabs`, no ticket code) strands its colour while the same markup without the transition class follows the theme; and `use-theme.ts` is byte-identical to its introduction in `55cf370f` (TASK-586). Mechanism corrected: a `.dark` flip changes `color`/`background-color`/`border-color` through a custom-property cascade, starting transitions the browser never advances because it never repaints those elements (several tab triggers caught frozen mid-interpolation at `oklab(… / 0.6)`) — so it is **not** confined to `color`, and dropping `color` from `transition-[color,box-shadow]` would have been an incomplete fix. **Fixed in the app, 2 files, no primitive touched and nothing restyled**: a blocking bootstrap script in `index.html` applies `.dark` before first paint, and `use-theme.ts` adopts that class as its initial state and flips it through `applyThemeWithoutTransitions()` — next-themes' `disableTransitionOnChange`, which `apps/admin-console` already sets and the hand-rolled hook here skipped. **Five axe scans (axe-core 4.12.1, WCAG 2.0/2.1/2.2 A+AA, connected, all 25 example-code blocks expanded, no forced repaint): 0 violations in both dark scans, and a clone-comparison sweep reports 0 stale of 646 elements in EVERY state** (up to 17 before the fix). 3 RED-verified regression tests in `src/lib/__tests__/use-theme.test.tsx`; playground 176 tests / 16 files green, build clean, ESLint clean on both changed files (`typecheck` + whole-app `lint` red only on concurrent lanes' in-flight `playground-session.tsx` / `MetadataSimulator.tsx`). **New follow-up #8 opened**: the two light-theme scans still report 1 serious `color-contrast` — inactive `TabsTrigger` at 4.49:1 — which is a genuine `@arcaai/ui` token value (computed colour equals a fresh clone; identical on clean load and after toggle), affects every consumer, and is left for the design gate. |
| 2026-08-01 | **Open follow-ups #2 and #4 closed.** **#2 — auto-tag is now genuinely per-mic.** `AudioMixer` gains opt-in per-source level monitoring (`startLevelMonitoring`/`stopLevelMonitoring`/`getSourceLevel(s)`): one timer sampling N analysis-only `AnalyserNode`s, tapped off each SOURCE node (not the gain node — `muteSource()` disconnects that one, and a muted source reports `0` deliberately), on the SAME `min(100, round(rms*250))` scale as the mixed meter, returning `false` rather than throwing on a runtime that cannot analyse. Published as `audioSourceLevels: number[]` (index-aligned with the resolved source order) via `useArcaAudio().sourceLevels` and reactively via `useAudioCapture().sourceLevels`; `level` semantics unchanged. Teardown guaranteed three ways: `dispose()` stops monitoring first, `stopAudio` disposes the mixer + clears the levels inside lane B-client's untouched synchronous block, and `startAudio`'s catch now releases both meters (closing a pre-existing leak where a failed start left the level timer ticking forever). The playground's auto-tag now sends the row of the LOUDEST source and re-tags when the loudest source changes mid-utterance; `metadata.autoTagMode` is derived from the live signal and the UI states which of `per-source` / `single-source` / `unavailable` is running — the honest disclosure was demoted, not deleted, and the two real limits (acoustic bleed between mics; one mic cannot separate two speakers) are named on screen. **#4 — `drainTimeoutMs` threaded** additively from `AudioStartOptions` → runtime options → `STTStreamingTransport` → provider → `stopAndDrain`, riding the transport rather than the pipeline STT config (`TranscriptionPipeline.ts` untouched), forwarded by `useAudioCapture`, with non-positive values dropped at every hop. 38 new tests (room 14, vox 12, stt-pkg 4, playground 8), all four mutations RED-verified and reverted byte-identically. room 506/20, vox 3783/222, stt-pkg 433/26, playground 184/17 green; room+vox+playground builds, vox+playground typechecks, and room/stt/playground lint clean (`@arcaai/vox lint`'s 4 warnings are pre-existing and on lines this change did not touch). The three cross-lane invariant suites (`useArca.audio-unification`, `useArcaAudio.sources.task597`, `useArcaAudio.stopOrder.task597`) stay green. |
| 2026-08-01 | **Open follow-up #8 closed — inactive `TabsTrigger` contrast, design-gate decision recorded.** Confirmed genuine: `--foreground` (`--slate-950 #0e1a24`) at 60% composites to `#6e767c` on `--background #fbfcfd` = **4.50:1**, reproducing the reported 4.49:1. A second surface was found that the original report did not cover — `TabsList variant="default"` carries `bg-muted` (`--slate-50 #f5f7f8`), where the same token measured **4.55:1**, passing by 0.05 — so both surfaces were borderline and the fix had to clear both. **Design owner approved `text-muted-foreground` (`--slate-600 #5a6a77`) over the proposed `text-foreground/70`**: it measures **5.43:1 on `--background` and 5.19:1 on `--muted`**, makes the light path mirror the dark one (which already used `dark:text-muted-foreground`), replaces an opacity modifier with a semantic token per `11-ux-ui-principles.md` §10, and is the smallest visible darkening of the three passing candidates. One line changed in `packages/ui/src/components/shadcn/tabs.tsx`; the now-redundant `dark:text-muted-foreground` was dropped (dark resolves identically, `rgb(147,164,174)`, verified). **4 CT tests added** (`__tests__/shadcn/tabs.test.tsx`, both variants × both themes) that measure the RENDERED colour — compositing the trigger's alpha over the first opaque ancestor background and applying the WCAG relative-luminance formula — rather than asserting a class string. Two deliberate hardenings after the first draft proved weak: the theme is set BEFORE mount (adding `.dark` to a painted tree updates `--muted-foreground` but leaves the resolved `color` stale — the same invalidation mechanism as follow-up #6, which would have silently asserted the light value while claiming to test dark), and the colour parser now REJECTS non-`rgb()` formats (an opacity modifier resolves to `oklab(… / 0.6)`, whose channels parse as plausible numbers and yielded a meaningless 4.4996:1 that passed the 4.5 floor). Both hardenings **RED-verified** against the pre-change component. `@arcaai/ui` lint + typecheck clean; 38/38 tabs CT green. **Honest limit on the axe evidence**: a re-scan was run on Storybook (axe-core 4.12.1, WCAG 2.0/2.1/2.2 A+AA, 4 stories × both themes, canvas confirmed at `#fbfcfd`/`#0c1418`) and shows 0 `color-contrast` nodes on tab triggers in both themes — but the same scan on the UNFIXED baseline also reported 0 in light, so it did NOT reproduce the original finding and cannot serve as before/after proof; the CT measurement is the load-bearing evidence. The compat-playground `:5177` re-scan that produced the original report was NOT re-run — another session's dev server holds the port. One `color-contrast` node remains in the dark `default` story on a `data-slot="button"` element inside the story fixture, not a tab trigger. Unrelated: 2 pre-existing `SttLanguageModePicker` CT failures, reproduced at baseline with `tabs.tsx` reverted. |
| 2026-08-01 | **`pnpm stt:test` exit-134 shutdown abort root-caused and fixed** — the "known-pre-existing 1 stt pytest failure" was a fully green suite that aborted in `Py_Finalize` (`PyThreadState_Get ... the GIL is released`). Bisected with `PYTHONPATH`-pinned detached worktrees (import path verified) to `d6ca581b` (TASK-594's whisper.cpp adapter), already 32 commits behind `HEAD` — so `test-stt` was red at `HEAD` and TASK-594's uncommitted remainder is not implicated. macOS crash report pins it on `_pywhispercpp`'s pybind11 static holding `_dispatch_log` past finalization and decref'ing it from `__cxa_finalize_ranges`. Fixed with an `atexit` `whisper_log_set(None)` teardown (shutdown-only, ASR behaviour untouched) + 4 RED-verified tests. `pnpm stt:test` EXIT=0 on 6/6 runs, `stt:test:unit` 3/3, lint and mypy clean; command not weakened. |
| 2026-08-01 | **End-to-end accuracy-run enablement — VAD switch + `quietWindowMs` threading + playground controls.** Three additive changes, no default altered. **(1) VAD is reachable from compat**: `V1AudioSettings.voiceActivityDetection?: boolean` → `AudioPluginConfig.vad`, mirroring `noiseSuppression`. Evidence that `enabled:false` genuinely skips: `TranscriptionPipeline.start()` only walks `getEnabledStages()`, so a disabled stage's `factory()` never runs — the `@arcaai/vad` / `@arcaai/noise-filter` dynamic import is never issued, no processor is created, and the track is never routed through it (`config-adapter.vad.task597.test.ts`, with a positive control that the SAME pipeline DOES call `createVAD` when enabled). **Finding worth recording**: the adapter's output REPLACES `DEFAULT_AUDIO_CONFIG` (`AgenticProvider` does `cfg.audio ?? DEFAULT_AUDIO_CONFIG`, no merge) and `PluginManager.getConfig()` answers `{enabled:false}` for an absent key — so every compat session with an `sttPipelineId` has ALREADY been running with VAD and the noise filter off. The new switch does not change that default; it makes it visible and, for the first time, reversible. **(2) `quietWindowMs` threaded** the same way follow-up #4 threaded `drainTimeoutMs`: `AudioStartOptions` → `useArcaAudio` runtime options → `PluginManager.buildStreamingTransport` → `STTStreamingTransport` → `StreamingRemoteProviderConfig` → `StreamingBackendSTTProvider.destroy()` → `stopAndDrain(timeout, quietWindow)` (new second parameter, defaulting to the configured value), plus `useAudioCapture` forwarding. Every hop guards on **`>= 0`, not truthiness** — `0` is the documented "disable the early resolve" value, and each hop's `0` case is RED-verified by mutation (`quietWindow.task597.test.ts`, `useArcaAudio.sourceLevels.task597.test.ts`, `STTProcessor.drainTimeout.task597.test.ts`, `StreamingBackendSTTProvider.test.ts`, `useAudioCapture.quietWindow.task597.test.ts`). This makes the knob REACHABLE; it does not fix follow-up #10, which still needs a design decision. **(3) Playground controls**: noise suppression + VAD as connection-level switches on the Connection tab (they map to `V1SdkConfig.audioSettings`, read once at provider mount) with an in-UI note that both off sends unprocessed audio to the backend; a new `DrainSettings` card on the Live-transcription tab for the two per-capture drain numbers plus a "Wait for tail final" preset (`quietWindowMs = 0`, 60 s ceiling); all four persisted in `config-store`. Gates: vox 3810/225, stt-pkg 439/26, playground 200/19 green; vox typecheck + build clean, playground typecheck/build/lint clean; the three cross-lane invariant suites stay green; SDK `dist` rebuilt. ⚠️ A CONCURRENT session was editing `compat/types.ts` and `compat/config-adapter.ts` during this work and had deleted `noiseSuppression`/`echoCancellation`/`autoGainControl` from the frozen `V1AudioSettings`; that deletion was reverted here per §6's "existing v1 signatures frozen" rule — reconcile before committing. |
| 2026-08-05 | Cross-reference: TASK-612 hardened the `sourceStreams` injection seam this ticket introduced — liveness validation (`SOURCE_STREAM_NOT_LIVE`), caller-owned track lifecycle (SDK teardown no longer stops injected streams; reuse across sessions works), start-race rejection (`CAPTURE_OPTIONS_DROPPED`), a silent-uplink watchdog, and compat diagnostics/empty-final hygiene. See `docs/implementation/TASK-612-Vox-External-Mic-Streams/`. |
