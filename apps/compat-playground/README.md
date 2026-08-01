# HOPE Compat Playground

A **standalone developer console** — `@arcaai/compat-playground` — modeling what a
real HOPE v1 → v2 migrating developer would build on `@arcaai/vox/compat`. It is
the runnable reference for the compat surface: connect with tenant credentials,
drive a live transcription session from real microphones *or* from an audio file,
score the result against a ground-truth transcript, and run the department →
pre-summary → summary chain — streaming or not.

Every tab ends with **the actual source it runs** (see [Example code](#example-code-per-tab)),
so nothing here can drift from what you just used.

## Setup

Build the workspace packages this app consumes first (same as any other consumer
of `@arcaai/ui`'s and `@arcaai/vox`'s compiled output):

```bash
pnpm ui:build
pnpm sdk:build
```

Bring up the stack (gateway `:8868` + STT + SMR) — see
[`infrastructure/README.md`](../../infrastructure/README.md):

```bash
pnpm setup:dev && pnpm stack:dev -- api stt smr
```

Run the playground:

```bash
pnpm compat:dev
# → http://localhost:5177
```

Or scoped to this package: `pnpm --filter @arcaai/compat-playground dev`.

## Layout — three isolated tabs

| Tab | Gated | What it is |
|---|---|---|
| **1 · Connection** | always available | Credentials → `V1SdkConfig` → `<ArcaCompatProvider>`, plus the pipeline picker |
| **2 · Live transcription** | requires a connection | Audio sources, engine toggle, start/stop, per-mic metadata, transcript timeline, WER/CER |
| **3 · Summarization** | requires a connection | Department / visit type / clinical context → pre-summary → summary |

Tabs 2 and 3 are `disabled` until you connect, with the reason spelled out on
screen (a silently dead control is a WCAG/UX failure).

Two structural rules hold the console together, and both are easy to break by
accident:

1. **Session state does not live in a tab.** `PlaygroundSessionProvider`
   ([`src/context/playground-session.tsx`](./src/context/playground-session.tsx))
   is mounted **inside** `<ArcaCompatProvider>` and **outside** `<Tabs>`. It owns
   the session, the mic, the transcript, the metadata simulator and the audio
   sources, and exposes them as named groups
   (`config`/`session`/`capture`/`transcript`/`language`/`metadata`/`audio`).
   That is what lets the Summarization tab read the caption the Live
   transcription tab produced.
2. **Every `<TabsContent>` is `forceMount` + `data-[state=inactive]:hidden`.**
   Radix unmounts inactive panels by default; unmounting one mid-recording would
   tear down a live session.

`<ArcaCompatProvider>` is mounted at exactly **one** place. Remounting it creates
a new Zustand store and kills the session — which is why the Connection tab goes
read-only once connected and requires an explicit Disconnect to edit.

---

## Tab 1 — Connection

No `<ArcaCompatProvider>` is mounted until you connect. Values persist to
**localStorage only** — never to the URL
([`src/lib/config-store.ts`](./src/lib/config-store.ts)); "Forget saved config"
clears them. Optional `VITE_*` variables prefill an empty form.

| Field | Maps to | Notes |
|---|---|---|
| API endpoint | `V1SdkConfig.apiEndpoint` | REST origin, e.g. `http://localhost:8868`. `websocketUrl` is derived (`http` → `ws`). |
| API key | `V1SdkConfig.credentials.apiKey` | **Required** — there is no default tenant key. Sent as `x-api-key`. |
| Tenant ID | `tenantId` | e.g. `50000000-0000-0000-0000-000000000000`. Only needed when the key is not bound to one tenant. |
| Pipeline ID | `V1SdkConfig.sttPipelineId` | A **`<Select>` of the tenant's real pipelines** (below). Empty = tenant default provider. |

### Pipeline picker

[`PipelinePicker.tsx`](./src/components/PipelinePicker.tsx) +
[`lib/pipelines.ts`](./src/lib/pipelines.ts) fetch
`GET {apiEndpoint}/api/v1/audio/pipelines` with `x-api-key` and render a
three-state control, mirroring the department picker:

- **loading** — a `<Skeleton>` while the fetch is in flight;
- **list** — the real pipelines, plus a `Tenant default (no pipeline)` entry and
  a permanent `Custom…` escape hatch;
- **freetext** — the original hand-typed input, on `401`/`403`, a network error,
  or an empty list, so a deployment without pipelines never blocks you.

The fetch is **debounced (400 ms)**: the tab re-renders on every keystroke, and
an undebounced effect posted a partially-typed API key to the gateway once per
character.

---

## Tab 2 — Live transcription

### Audio source (R3)

[`AudioSourcePanel.tsx`](./src/components/AudioSourcePanel.tsx) +
[`hooks/use-audio-sources.ts`](./src/hooks/use-audio-sources.ts) +
[`lib/file-audio-source.ts`](./src/lib/file-audio-source.ts). Four modes, **one**
capture graph — mixer → noise filter → VAD → STT:

| Mode | What reaches the SDK |
|---|---|
| One microphone | `audio.start({ deviceId })` |
| Multiple microphones (mixed) | `+ secondaryDeviceId, additionalDeviceIds` — N mics summed by `@arcaai/room`'s `AudioMixer` into **one** uplink stream |
| Audio file → one microphone | `audio.start({ sourceStreams: [stream] })` |
| Audio file(s) → multiple microphones | one stream per virtual mic (or a stereo file split L/R), mixed identically |

The `additionalDeviceIds` / `sourceStreams` / `sourceGains` fields are
additive-optional additions to `AudioStartOptions` made for this app; a single
source still skips the mixer entirely, so pre-existing behaviour is unchanged.

- Device **labels stay blank until microphone permission is granted** — the panel
  shows a "Grant microphone access" affordance rather than an empty list.
- Selection order **is** mixer order, and each source gets a gain slider.
- File modes decode with `AudioContext.decodeAudioData` and drive
  `AudioBufferSourceNode → MediaStreamAudioDestinationNode`, with play / pause /
  seek / loop / rate controls. Playback **follows the recording lifecycle**: it
  starts on Start and pauses on Stop, because a paused file source feeds silence,
  which is indistinguishable from a broken STT session.
- The whole panel **locks while a session is live and through the finalizing
  drain** — the run's configuration must keep describing what actually streamed.

File modes exist so a run is deterministic and repeatable, which is what makes
the WER/CER numbers below comparable across pipeline switches.

### Engine toggle (pipeline ↔ tenant default)

[`ProviderToggle.tsx`](./src/components/ProviderToggle.tsx) drives
`useArcaSttProvider()`:

- **ON** (`usePipeline: true`) → `switchToPipeline()` — the SDK-configured
  pipeline from the Connection tab.
- **OFF** → `switchToDefault()` — the tenant admin's configured default provider.
- The flip is **mid-session with no reconnect**: the mic keeps recording and the
  transcript keeps flowing across it.
- `onProviderSwitched` / `onSwitchFailed` surface as `toast.success()` /
  `toast.error()` — this fires for a user-initiated switch **and** for a backend
  auto-switch (e.g. a provider outage).
- Before capture exists the hook records a *pending* choice rather than
  switching, so the badge reads `pending` / `fallback queued` instead of
  claiming an engine changed.

### Start / stop (R4)

Stop is **reactive**: the mic is released and the UI leaves `recording`
synchronously on click, while the STT transport keeps draining behind it. That
window is a real state — `capture.phase` is
`'idle' | 'starting' | 'recording' | 'stopping'`:

- the Stop button reads **"Finalizing…"** with a `role="status"` line saying the
  mic is released and the last lines are still arriving;
- **tail finals keep appending** to the transcript for the whole `stopping`
  window;
- Start stays disabled until `phase` returns to `idle`, so it cannot be re-armed
  on a half-closed session.

Controls read `phase`, not `isRecording`, wherever the drain window matters:
source selection stays **locked** through it; the metadata form stays **usable**
through it (it tags the next line, which may still be arriving); auto-tag is the
one control gated on `recording` alone, because it reads the live input level.

### Metadata simulator (R5)

[`MetadataSimulator.tsx`](./src/components/MetadataSimulator.tsx). Two surfaces
over `sendAudioData`:

1. The single-shot **Simulate metadata** form (`speaker_id`, `language`, plus a
   free-form JSON object).
2. **Per-mic rows** — one `{mic, speaker, …json}` row per configured source,
   exactly the reference screenshot's shape. Send a row by hand, or flip
   **Auto-tag** to emit automatically when the input level crosses a threshold.
   Rows can be synced from the configured audio sources with one click (never
   auto-overwritten — your manual edits stand).

Two honesty notes are stated **in the UI**, not just here:

> **This metadata never reaches the STT socket.** The v2 gateway
> (`/ws/stt/stream`) accepts only `audio | stop | resume | close`;
> `sendAudioData` records metadata client-side and replays it onto the next
> transcript line by timestamp. The v1 compat gateway (`/stt`) *does* carry
> per-frame metadata on the wire, but its attribution is also last-wins/sticky.
> **Both paths are recency-attributed — only the transport differs.**

> **Auto-tag cannot do true per-mic attribution.** The SDK exposes exactly one
> *mixed-stream* level meter, not a per-source signal, so auto-tag rotates
> round-robin through the rows on each debounced threshold crossing. Real
> attribution needs a per-source `AnalyserNode` in `AudioMixer`'s node graph —
> an open follow-up.

Payloads are validated against the SDK's 8 KB `MAX_METADATA_BYTES` guard
**before** sending, and a violation renders as an inline `FieldError`
(`role="alert"`), not a toast.

### Live results

[`TranscriptColumn.tsx`](./src/components/TranscriptColumn.tsx) renders ONE
timeline split into two aligned tracks: the transcription (with a `mm:ss.mmm`
timestamp) on the left, and the metadata that round-tripped with it (TASK-564
passthrough) on the right, row by row. Metadata gets first-class badges for
`mic`, `speaker`, `speaker_id`, `detected_language`, `chunk_id` and the
start/end times, with the full payload in a collapsible `raw` block.

### Reference scoring — WER / CER (R6)

[`ScorecardPanel.tsx`](./src/components/ScorecardPanel.tsx) +
[`lib/scoring.ts`](./src/lib/scoring.ts). Paste a ground-truth transcript or
upload `.txt` / `.srt` / `.vtt`, and the live hypothesis is scored against it:
WER, CER, substitutions / insertions / deletions, hits, and a word-level aligned
diff (colour **plus** a `~`/`+`/`−` marker **plus** an `sr-only` op name — never
colour alone).

> Normalization and CER are a **behavioural port of
> [`apps/stt/scripts/mlen_scorecard.py`](../stt/scripts/mlen_scorecard.py)** —
> the same code the TASK-594 Malayalam-English quality gate runs — verified
> against the real Python on 11 shared fixtures at full float precision. A CER
> shown here and a CER in the regression baseline mean the same thing. **Do not
> "improve" the normalizer**; change it only in lockstep with the Python script.
>
> It does exactly three things: NFC → collapse whitespace runs → strip. It does
> **not** fold case, strip punctuation, normalize digits, or transliterate.

**Export run (JSON)** writes the reference, the hypothesis, the normalized
strings, the scores, the alignment, and the run context — pipeline id, language
mode, session id, reference source, and a description of the audio source — so
two runs are comparable across a pipeline switch.

---

## Tab 3 — Summarization

[`SummaryCard.tsx`](./src/components/SummaryCard.tsx) orchestrates `useSMR()`
from `@arcaai/vox/compat`; [`summarization/`](./src/components/summarization/)
holds the presentational pieces.

- **Department picker** — fetches
  `GET {apiEndpoint}/api/v1/admin/departments` (header `x-api-key`) and renders a
  `<Select>`; on `401`/`403`, a network error, or an empty list it falls back to
  a free-text input (a `<Skeleton>` shows while the fetch is in flight). The
  gateway resolves the submitted string against the tenant's real `Department`
  rows — by code, name, or v1 synonym — to select a governed instruction
  template; unmatched names fall back to static steering.
- **Visit type** — two presets, `New / Referral` and `Follow-up / Review`,
  mirroring the two canonical categories the gateway normalizes any submitted
  string into (`new`/`referral`/`initial`/… → new-referral;
  `follow`/`review`/`revisit` → follow-up), plus a `Custom…` free-text escape
  hatch. A stored legacy value opens in custom mode rather than leaving the
  `<Select>` empty.
- **Clinical context** — age, DOB, gender, vitals, test results, previous visits,
  feeding the `PreSummaryRequest`.
- **Transcript source** — an explicit three-way selector: `live transcript` ·
  `pasted` · `live + additional context`. The pasted buffer is independent and
  seeded by an explicit one-time "Copy live transcript" snapshot, so editing it
  never mutates the live buffer.
- **Pre-summarize** calls `preSummarize(...)` and stores the returned
  `pre_summary`; **Summarize** calls `summarizeSync({ text, departmentId,
  visitType, preSummaryText, includePreSummaryInContext: true,
  useEnhancedFormat })` and renders the Enhanced / Simplified / SOAP result.
  Summarize is disabled with a visible reason until a transcript exists.
- **Streaming toggle (R10)** — threads `{ stream: true, onDelta }` through both
  `preSummarize` and `summarizeSync` to the SSE path that the SDK and gateway
  already ship. On the terminal `result` event the same render path runs as the
  non-streaming case, so the final output is identical either way.

  > Worth knowing when demoing: the gateway re-emits SMR `chunk` frames as
  > `delta`, i.e. **raw text, not partial structured JSON**. With the Enhanced /
  > SOAP formats the live stream shows unstructured model output and only snaps
  > into the structured view on the terminal `result`. That is real backend
  > behaviour, and the streaming preview is labelled accordingly.

  SSE `error` frames and the "stream ended without a result event" guard both
  arrive as plain `Error`s and surface as `toast.error` — never a silent stall.

Last-used department and visit type persist to localStorage.

This tab is a superset of `apps/example`'s
[`compat-consultation.tsx`](../example/src/compat-consultation.tsx) demo — that
one hardcodes the department/visit type and skips the pre-summary step.

---

## Example code (per tab)

[`TabExampleCode.tsx`](./src/components/TabExampleCode.tsx) renders, at the **end
of every tab**, the real source of the files that tab is built from — read off
disk at runtime via Vite `import.meta.glob(…, { query: '?raw' })`. It is not a
paraphrase and it cannot drift.

⚠️ The glob array is analysed **statically** by Vite, so it must contain a
literal string for every listed path. A missing entry used to yield a silently
empty code block; now `loadExampleSource` rejects instead, and
[`__tests__/TabExampleCode.test.tsx`](./src/components/__tests__/TabExampleCode.test.tsx)
loads every file of every tab and asserts non-empty content — add a file to a
list without adding it to the glob and that test fails.

---

## Scripts

| Command | Effect |
|---|---|
| `pnpm compat:dev` / `pnpm --filter @arcaai/compat-playground dev` | Vite dev server on port 5177 |
| `pnpm compat:build` / `… build` | Production build |
| `pnpm compat:typecheck` / `… typecheck` | `tsc --noEmit` |
| `pnpm compat:lint` / `… lint` | `eslint src --max-warnings 0` |
| `pnpm compat:lint:fix` / `… lint:fix` | `eslint src --fix` |
| `pnpm --filter @arcaai/compat-playground test` | Vitest component tests |
| `pnpm --filter @arcaai/compat-playground preview` | Preview the production build |

Lint uses `@arcaai/config-eslint/flat/react-library.js`
([`eslint.config.mjs`](./eslint.config.mjs)). That preset loads
`eslint-plugin-only-warn`, so every finding is a *warning* — hence
`--max-warnings 0`, matching `@arcaai/ui` and `@arcaai/admin-console`.

## Tests

Component tests (Vitest + Testing Library, `happy-dom`) live in colocated
`__tests__/*.test.tsx` files. The suffix matters: `vitest.config.ts` collects
only `src/**/*.test.tsx`, so a `.test.ts` file would be **silently skipped**.

```bash
pnpm --filter @arcaai/compat-playground test
```

## Structure

```
src/
├── main.tsx                          # entry — mounts <App />
├── App.tsx                           # three tabs, the connection gate, one provider mount
├── index.css                         # Tailwind v4 + @arcaai/ui token import
├── context/
│   └── playground-session.tsx        # the lifted session (mounted above the tabs)
├── components/
│   ├── ConnectionTab.tsx             # tab 1 — credentials + Connect
│   ├── PipelinePicker.tsx            # real tenant pipelines, free-text fallback
│   ├── LiveTranscriptionTab.tsx      # tab 2 — layout
│   ├── AudioSourcePanel.tsx          # mic / multi-mic / file source picker
│   ├── ControllerColumn.tsx          # language, engine toggle, start/stop
│   ├── ProviderToggle.tsx            # pipeline ↔ tenant-default engine switch
│   ├── MetadataSimulator.tsx         # manual + per-mic metadata rows, auto-tag
│   ├── TranscriptColumn.tsx          # the two-track transcript | metadata timeline
│   ├── ScorecardPanel.tsx            # reference transcript, WER/CER, run export
│   ├── SummarizationTab.tsx          # tab 3 — layout
│   ├── SummaryCard.tsx               # useSMR() orchestration + streaming toggle
│   ├── summarization/                # ContextForm · TranscriptSource · SummaryResultView
│   └── TabExampleCode.tsx            # per-tab source, via import.meta.glob(?raw)
├── hooks/
│   └── use-audio-sources.ts          # device enumeration + resolved capture options
└── lib/
    ├── config-store.ts               # config shape + localStorage persistence
    ├── departments.ts                # GET /api/v1/admin/departments
    ├── pipelines.ts                  # GET /api/v1/audio/pipelines
    ├── file-audio-source.ts          # decodeAudioData → MediaStream, per virtual mic
    ├── scoring.ts                    # WER/CER, ported from mlen_scorecard.py
    └── use-theme.ts                  # light/dark toggle
```

## Related tickets

| Ticket | What it added here |
|---|---|
| TASK-586 | The app itself + the ON/OFF STT provider toggle |
| TASK-587 | STT language-mode picker (`useArcaSttLanguageModes`) |
| TASK-592 | Pre-summarization → summarization surface |
| TASK-597 | Three-tab console, audio sources, reactive stop, per-mic metadata, WER/CER, pipeline picker, streaming summarization, per-tab example code |
