# compat-playground — runnable reference for @arcaai/vox/compat

`@arcaai/compat-playground`, a standalone Vite + React developer console (port 5177) modeling
what a real HOPE v1-to-v2 migrating developer would build on `@arcaai/vox/compat`. It connects
with tenant credentials, drives a live transcription session from microphones or an audio file,
scores the result against a ground-truth transcript, batch-uploads pre-recorded audio, and runs
the department to pre-summary to summary chain, streaming or not. Every tab ends with the actual
source it runs, read off disk at runtime, so the demo cannot drift from its own documentation.

**Deprecated.** CI no longer tests, builds, scans, or promotes this app — the aggregate repo
scripts (`pnpm lint`/`test`/`build`/`typecheck`) skip it (`.claude/rules/01-development-workflow.md`
Test Scope Exclusions). Local opt-in only, via `pnpm compat:dev`.

## Layout

```
src/
  main.tsx                    entry - mounts <App />
  App.tsx                     the four-tab console, the connection gate, one provider mount
  context/playground-session.tsx   the lifted session, mounted above the tabs
  components/
    ConnectionTab.tsx          tab 1 - credentials + Connect
    PipelinePicker.tsx         real tenant pipelines, free-text fallback
    LiveTranscriptionTab.tsx   tab 2 - layout
    AudioSourcePanel.tsx       mic / multi-mic / file source picker
    ControllerColumn.tsx       language, engine toggle, start/stop
    DrainSettings.tsx          per-capture stop-drain timeout + quiet window
    ProviderToggle.tsx         pipeline <-> tenant-default engine switch
    MetadataSimulator.tsx      manual + per-mic metadata rows, auto-tag
    TranscriptColumn.tsx       the two-track transcript | metadata timeline
    ScorecardPanel.tsx         reference transcript, WER/CER, run export
    BatchUploadTab.tsx         tab 3 - layout
    batch/                     BatchUploadPanel, BatchJobQueue, BatchJobResult, BatchAllResultsView, BatchResultsPanel
    SummarizationTab.tsx       tab 4 - layout
    SummaryCard.tsx            useText() orchestration + streaming toggle
    summarization/             ContextForm, TranscriptSource, SummaryResultView
    TabExampleCode.tsx         per-tab source, via import.meta.glob(?raw)
  hooks/use-audio-sources.ts   device enumeration + resolved capture options
  lib/
    config-store.ts            config shape + localStorage persistence
    departments.ts             GET /api/v1/admin/departments
    pipelines.ts                GET /api/v1/audio/pipelines
    file-audio-source.ts       decodeAudioData -> MediaStream, per virtual mic
    scoring.ts                  WER/CER, ported from apps/stt/scripts/mlen_scorecard.py
```

## Commands

| Command | Effect |
|---|---|
| `pnpm compat:dev` (in-package: `pnpm dev`) | Vite dev server on port 5177 |
| `pnpm compat:build` (in-package: `pnpm build`) | Production build |
| `pnpm compat:typecheck` (in-package: `pnpm typecheck`) | `tsc --noEmit` |
| `pnpm compat:lint` / `compat:lint:fix` (in-package: `pnpm lint` / `lint:fix`) | `eslint src --max-warnings 0` |
| `pnpm --filter @arcaai/compat-playground test` | Vitest component tests (no root alias — this workspace is excluded from the aggregate `pnpm test`) |
| `pnpm --filter @arcaai/compat-playground preview` | Preview the production build |

Lint uses `@arcaai/config-eslint/flat/react-library.js`, which loads `eslint-plugin-only-warn` —
every finding is a warning, hence `--max-warnings 0`.

## How it works

Build the workspace packages this app consumes first, then bring up the gateway + STT + Text
stack (see `infrastructure/README.md`):

```bash
pnpm ui:build && pnpm sdk:build
pnpm setup:dev && pnpm stack:dev -- api stt text
pnpm compat:dev
# -> http://localhost:5177
```

### Four isolated tabs

| Tab | Gated | What it is |
|---|---|---|
| 1 - Connection | always available | Credentials -> `V1SdkConfig` -> `<ArcaCompatProvider>`, plus the pipeline picker |
| 2 - Live transcription | requires a connection | Audio sources, engine toggle, start/stop, per-mic metadata, transcript timeline, WER/CER |
| 3 - Batch upload | requires a connection | Pre-recorded files -> one transcription job each -> streamed results -> hand-off to Summarization |
| 4 - Summarization | requires a connection | Department / visit type / clinical context -> pre-summary -> summary |

Tabs 2-4 are `disabled` until you connect, with the reason spelled out on screen.

Two structural rules hold the console together:

1. **Session state does not live in a tab.** `PlaygroundSessionProvider`
   (`src/context/playground-session.tsx`) mounts inside `<ArcaCompatProvider>` and outside
   `<Tabs>`. It owns the session, the mic, the transcript, the metadata simulator and the audio
   sources, exposed as named groups (`config`/`session`/`capture`/`transcript`/`language`/
   `metadata`/`audio`/`batch`) — this is what lets the Summarization tab read the caption the
   Live transcription tab produced.
2. **Every `<TabsContent>` is `forceMount` + `data-[state=inactive]:hidden`.** Radix unmounts
   inactive panels by default; unmounting one mid-recording would tear down a live session.

`<ArcaCompatProvider>` is mounted at exactly one place. Remounting it creates a new Zustand store
and kills the session — which is why the Connection tab goes read-only once connected and
requires an explicit Disconnect to edit.

### Tab 1 - Connection

No `<ArcaCompatProvider>` is mounted until you connect. Values persist to localStorage only,
never to the URL (`src/lib/config-store.ts`); "Forget saved config" clears them.

| Field | Maps to | Notes |
|---|---|---|
| API endpoint | `V1SdkConfig.apiEndpoint` | REST origin; `websocketUrl` is derived (`http` -> `ws`) |
| API key | `V1SdkConfig.credentials.apiKey` | Required, sent as `x-api-key` |
| Tenant ID | `tenantId` | Only needed when the key is not bound to one tenant |
| Pipeline ID | `V1SdkConfig.sttPipelineId` | A `<Select>` of the tenant's real pipelines (`GET /api/v1/audio/pipelines`); empty = tenant default provider |

The pipeline picker fetches with `x-api-key` and renders three states: loading (`<Skeleton>`),
list (real pipelines + a `Tenant default` entry + a `Custom...` escape hatch), and freetext
fallback on 401/403, a network error, or an empty list. The fetch is debounced 400ms so an
undebounced effect cannot post a partially-typed API key to the gateway once per keystroke.

### Tab 2 - Live transcription

Four audio-source modes share one capture graph (mixer -> noise filter -> VAD -> STT): one
microphone, multiple mixed microphones (`@arcaai/room`'s `AudioMixer`), an audio file into one
virtual microphone, or audio files into multiple virtual microphones. Device labels stay blank
until microphone permission is granted. File modes decode with `AudioContext.decodeAudioData`
and drive `AudioBufferSourceNode -> MediaStreamAudioDestinationNode`; playback follows the
recording lifecycle (starts on Start, pauses on Stop) because a paused file source feeds silence,
which is indistinguishable from a broken STT session. The whole panel locks while a session is
live and through the finalizing drain.

The engine toggle (`ProviderToggle.tsx`, `useArcaSttProvider()`) flips between the SDK-configured
pipeline and the tenant admin's default provider mid-session with no reconnect; before capture
exists it records a pending choice instead of switching.

Stop is reactive: the mic releases and the UI leaves `recording` synchronously on click, while
the transport keeps draining behind it (`capture.phase`: `idle | starting | recording |
stopping`). Tail finals keep appending for the whole `stopping` window; Start stays disabled
until `phase` returns to `idle`. `DrainSettings.tsx` configures that window: a stop-drain timeout
and a quiet-window override (`quietWindowMs: 0` disables the quiet-window heuristic, forcing the
full timeout every time) — both apply to the next capture only.

The metadata simulator (`MetadataSimulator.tsx`) sends through `sendAudioData`: a single-shot
form, or per-mic rows with an Auto-tag mode that emits automatically on input-level threshold.
Two facts are stated in the UI itself: this metadata never reaches the STT socket — the v2
gateway (`/ws/stt/stream`) accepts only `audio | stop | resume | close`; `sendAudioData` records
metadata client-side and replays it onto the next transcript line by timestamp (the v1 compat
gateway at `/stt` does carry per-frame metadata on the wire, but its attribution is also
last-wins/sticky — both paths are recency-attributed, only the transport differs). And auto-tag
does true per-mic attribution via the SDK's real per-source level meters, falling back to
round-robin only when the runtime reports no per-source signal. Payloads are validated against
the SDK's 8 KB `MAX_METADATA_BYTES` guard before sending.

Reference scoring (`ScorecardPanel.tsx` + `lib/scoring.ts`) computes WER/CER against a pasted or
uploaded ground-truth transcript. Normalization and CER are a behavioural port of
`apps/stt/scripts/mlen_scorecard.py` — verified against the real Python on shared fixtures at
full float precision. Do not "improve" the normalizer independently of that script; it does
exactly three things (NFC, collapse whitespace runs, strip) and nothing else.

### Tab 3 - Batch upload

Drives `useArcaBatchTranscription()` — drop or choose N audio files, each becomes one backend
transcription job. Pipeline selection applies to the next enqueue only; queued files keep the
pipeline they were queued with. "Files in flight at once" bounds both the upload and the result
stream, since a slot is held for the whole job lifecycle. "Send to Summarization" pushes a
completed transcript into Tab 4 as its `Pasted` transcript source.

### Tab 4 - Summarization

`SummaryCard.tsx` orchestrates `useText()` from `@arcaai/vox/compat`. The department picker
fetches `GET /api/v1/admin/departments` and falls back to free text on 401/403, a network error,
or an empty list — the gateway resolves the submitted string against the tenant's real
`Department` rows (by code, name, or v1 synonym). Visit type offers two presets plus a
`Custom...` escape hatch, mirroring the two categories the gateway normalizes any submitted
string into. The transcript source is an explicit three-way selector (live / pasted / live +
additional context); the pasted buffer is independent, seeded only by an explicit one-time
snapshot. The streaming toggle threads `{ stream: true, onDelta }` through both `preSummarize`
and `summarizeSync` — worth knowing when demoing: the gateway re-emits Text `chunk` frames as
`delta` (raw text, not partial structured JSON), so the Enhanced/SOAP formats show unstructured
output mid-stream and only snap into the structured view on the terminal `result` event.

### Example code per tab

`TabExampleCode.tsx` renders, at the end of every tab, the real source of the files that tab is
built from, read off disk at runtime via Vite `import.meta.glob(..., { query: '?raw' })`.

## Gotchas

- The `import.meta.glob` array in `TabExampleCode.tsx` is analysed statically by Vite, so every
  listed path must be a literal string. `loadExampleSource` rejects on a missing entry (it used
  to silently render an empty code block), and `src/components/__tests__/TabExampleCode.test.tsx`
  loads every file of every tab and asserts non-empty content — add a file to a tab's list
  without adding it to the glob and that test fails.
- Component tests must be named `*.test.tsx`, not `*.test.ts` — `vitest.config.ts` only collects
  `src/**/*.test.tsx`, so the wrong suffix is silently skipped rather than reported as missing.
- This workspace is excluded from the aggregate `pnpm lint`/`test`/`build`/`typecheck`; run its
  scripts with the `compat:*` root aliases or `pnpm --filter @arcaai/compat-playground <script>`.

## Related

- `apps/example/README.md` — a smaller, hardcoded compat demo; this app's Summarization tab is a
  superset of its `compat-consultation.tsx`
- `packages/agentic-sdk-v2/docs/Compat-API-Reference.md` — the `@arcaai/vox/compat` surface this app exercises
- `.claude/rules/01-development-workflow.md` — Test Scope Exclusions (why this app is CI-hidden)
- `.claude/rules/08-vox-sdk.md` — the SDK entry points and the `pipelineId` deprecation this app's Connection tab still uses
