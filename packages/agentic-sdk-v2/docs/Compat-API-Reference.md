# @arcaai/vox/compat — API Reference

**Package**: `@arcaai/vox` &middot; **Entry point**: `@arcaai/vox/compat` &middot; **Version**: 2.0.1

> Verified directly against source in `packages/agentic-sdk-v2/src/compat/` (2026-08-05).
> This document covers **only** the v1-compat surface. For the rest of the SDK
> (core hooks, audio pipeline, session lifecycle), see
> [`../README.md`](../README.md) and [`API-Reference.md`](API-Reference.md).

## Table of Contents

- [Installation](#installation)
- [Purpose](#purpose)
- [Entry-bundle isolation](#entry-bundle-isolation)
- [Setup — `ArcaCompatProvider`](#setup--arcacompatprovider)
- [1. `useArcaSessionManager`](#1-usearcasessionmanager)
- [2. `useAudioCapture`](#2-useaudiocapture)
- [3. `useArcaSpeechToText`](#3-usearcaspeechtotext)
- [4. `useText`](#4-usetext)
- [5. `useArcaSttProvider`](#5-usearcasttprovider)
- [6. `useArcaSttLanguageModes`](#6-usearcasttlanguagemodes)
- [7. `useArcaBatchTranscription`](#7-usearcabatchtranscription)
- [8. External microphones & injected streams](#8-external-microphones--injected-streams)
- [9. Reproduced v1 type surface](#9-reproduced-v1-type-surface)
- [10. Defects/anti-patterns deliberately not reproduced](#10-defectsanti-patterns-deliberately-not-reproduced)
- [Related docs](#related-docs)
- [Source file index](#source-file-index)

## Installation

`@arcaai/vox` (the package the `/compat` entry ships from) is published to **GitHub
Packages**, not the public npm registry — install requires a scoped registry
mapping plus an authenticated token, even for a public/`read:packages`-only pull.

### 1. Authenticate to GitHub Packages (one-time, per machine)

1. Create a GitHub PAT (classic) with at least the `read:packages` scope, for
   an account with read access to `ArcaAI/project-hope`.
2. Point the `@arcaai` scope at the GitHub Packages registry and supply the
   token. Either your **global** `~/.npmrc` or a **project-local** `.npmrc`
   (add it to `.gitignore` — never commit a token):
   ```
   @arcaai:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
   ```
   pnpm/yarn read the same `.npmrc` format; no extra config needed beyond this.

### 2. Install

```bash
pnpm add @arcaai/vox@2.0.1
# or: npm install @arcaai/vox@2.0.1 / yarn add @arcaai/vox@2.0.1
```

`@arcaai/vox`'s own dependencies (`@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`,
`@arcaai/noise-filter`, and the optional peer `@arcaai/med-ner`) resolve
transitively from the **same** `@arcaai` registry mapping above — no separate
install step. Peer dependencies you must satisfy yourself: `react` /
`react-dom` `^18.3.0 || ^19.0.4`.

If `pnpm add` 404s or 401s, the registry mapping/token from step 1 is the
first thing to check — a plain `npm.pkg.github.com` 404 for a scoped package
almost always means an unauthenticated request or a token missing
`read:packages`. (Publishing — not relevant to installing as a consumer — is
covered in [`docs/operations/vox-sdk-release/README.md`](../../../docs/operations/vox-sdk-release/README.md).)

### 3. Import the compat entry

Nothing else compat-specific to install — `/compat` is a bundle inside the
same `@arcaai/vox` package (see [Entry-bundle isolation](#entry-bundle-isolation)
below), not a separate install:

```ts
import { ArcaCompatProvider, useText, type V1SdkConfig } from '@arcaai/vox/compat';
```

Every compat module carries `"use client"` — in a Next.js App Router consumer,
render `<ArcaCompatProvider>` from a client component (or a client boundary
that wraps the page).

## Purpose

`@arcaai/vox/compat` lets a HOPE v1 app (`@arcaai/agentic-sdk`) move to this SDK by
changing an import specifier and adding one provider — no rewrite of call sites.
Every compat hook is a thin adapter that **only consumes the public v2 API**
(the hooks/store/clients documented in the main README) — none of them reach
into v2 internals, and none of them modify v2 core hooks, store, or clients.
Every compat module carries `"use client"`.

## Entry-bundle isolation

Each SDK entry point (`.`, `/core`, `/plugins`, `/plugins/med-ner`, `/compat`) is
built as a **separate bundle** (`tsup.config.ts`, `splitting: false`). A
component tree rendered under `<ArcaCompatProvider>` must import **every** hook
it uses — including v2-native ones like `useArcaSttLanguageModes` — from
`/compat`, not `/core`. Importing the "same" hook from a different entry point
inside a `/compat`-provided tree makes `useStoreApi()` read a different React
context instance and **throw**.

## Setup — `ArcaCompatProvider`

```tsx
import { ArcaCompatProvider, type V1SdkConfig } from '@arcaai/vox/compat';

const v1Config: V1SdkConfig = {
  apiEndpoint: 'https://api.arcaai.example.com', // bare origin — the adapter normalizes it to .../api/v1
  websocketUrl: 'wss://api.arcaai.example.com',
  credentials: { apiKey: 'your-api-key' }, // REQUIRED — throws if missing/blank
  audioSettings: { noiseSuppression: true },
  environment: 'production', // 'development' also flips debug: true
  sttPipelineId: 'pipeline-id', // backend ASR pipeline for live streaming
  tenantId: 'tenant-id', // optional, parity only — the API key is authoritative for tenancy
  enableProviderSwitch: true, // required only for useArcaSttProvider().switchToPipeline()
};

<ArcaCompatProvider options={v1Config}>
  <ConsultationPage />
</ArcaCompatProvider>;
```

### `V1SdkConfig` (full shape)

| Field | Type | Notes |
| --- | --- | --- |
| `apiEndpoint` | `string` | REST base, e.g. `https://api.arcaai.com`. v1 configured the bare origin; the adapter normalizes it up to `/api/v1` for v2's `AgenticClient`. |
| `websocketUrl` | `string` | WS base, e.g. `wss://api.arcaai.com`. |
| `credentials?.apiKey` | `string` | **Required.** `mapV1ConfigToAgenticConfig` throws `"credentials.apiKey is required"` if missing/blank — v2 has **no** baked-in default key (v1 did; that default is deliberately not reproduced). |
| `audioSettings?` | `V1AudioSettings` | `{ sampleRate?, format?, channels?, noiseSuppression?, echoCancellation?, autoGainControl?, voiceActivityDetection? }`. Only `noiseSuppression` (→ `audio.noiseFilter.enabled`, level fixed at `'medium'`) and `voiceActivityDetection` (TASK-597, → `audio.vad.enabled`) are currently mapped. |
| `environment?` | `'development' \| 'staging' \| 'production'` | `'development'` → `debug: true`. |
| `sttPipelineId?` | `string` | Backend ASR pipeline id for live streaming. v1 had no equivalent (its STT WS was API-key-flat); omit for local STT. |
| `tenantId?` | `string` | TASK-586 addition. Accepted for parity; the v2 gateway resolves tenancy **authoritatively from the API key** — a mismatched value here is never trusted over the key. |
| `enableProviderSwitch?` | `boolean` | TASK-586 addition, default `false`. `true` lets `useArcaSttProvider().switchToPipeline()` switch **back** to the SDK-configured pipeline via the compat gateway's `POST /api/stt/switch` shim. `false`/omitted limits switching to the one-way TASK-567/568 fallback route. |

`ArcaCompatProvider` maps `options` via `mapV1ConfigToAgenticConfig` and renders
`<AgenticProvider config={...}>` underneath — it is a drop-in replacement for a
v1 provider, not a second store. `enableProviderSwitch` also rides a small
internal `CompatFeatureFlagsContext`, consumed only by `useArcaSttProvider`
(not part of the public API).

**Audio config gotcha:** `AgenticProvider` resolves `cfg.audio ?? DEFAULT_AUDIO_CONFIG` — it does **not** merge — and a missing plugin key resolves to `{ enabled: false }`. So the moment `audioSettings` or `sttPipelineId` is set (which emits *some* audio config), every stage the adapter doesn't emit a preference for is **OFF**, not defaulted. Stating `noiseSuppression`/`voiceActivityDetection` explicitly is the only way to turn a stage on as well as off.

---

## 1. `useArcaSessionManager`

v1 session hook reproduced over v2's `useArcaSession`.

```ts
function useArcaSessionManager(props: {
  sessionId?: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  options?: Record<string, unknown>;
  onError?: (error: ErrorInfo) => void;
}): {
  session: MedicalSession | null;
  isLoading: boolean;
  error: ErrorInfo | null;
  createSession: (metadata?: Partial<SessionMetadata>) => Promise<MedicalSession>;
  startSession: () => Promise<void>;
  pauseSession: (reason?: string) => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
  loadSession: (id: string) => Promise<MedicalSession>;
  updateSession: (data?: Record<string, unknown>) => Promise<void>;
  clearError: () => void;
};

/** v2 ConsultationStatus → v1 SessionStatus. */
function mapV2StatusToV1(status?: ConsultationStatus): SessionStatus;
// OPEN/active → IDLE · RECORDING/TRANSCRIBING/SUMMARIZING/REVIEW → ACTIVE
// CLOSED/completed → TERMINATED · CANCELLED/cancelled → TERMINATED
```

**Behavior:**
- `createSession(metadata)` and `startSession()` **collapse onto one idempotent** `useArcaSession().open({ patientId, department, metadata })` — an internal `openedRef` guard means calling both never double-opens.
- `doctorId` is **never sent as a top-level field** — v2 derives the provider identity from auth. It's preserved only in `session.metadata.legacyDoctorId`.
- `pauseSession`/`resumeSession` have **no v2 backend equivalent** — they only set local React state (`localStatus`); no server call happens.
- `endSession()` → `session.close()`. `loadSession(id)` → `session.loadConsultation(id)`. `updateSession(data)` → `session.update({ metadata: data })`.
- The returned `session` is a **synthesized view** built from the v2 `Consultation` plus the local status override — not a raw passthrough of any v2 object.
- `metadata` defaults: `tags: ['medical-consultation']`, `priority: 'medium'`, `sessionType: 'consultation'`, `customFields: {}`, `patientInfo: { id: patientId, name: patientName }`, `providerInfo: { id: doctorId, name: doctorName }`.

## 2. `useAudioCapture`

v1 capture hook reproduced over v2's `useArcaAudio`.

```ts
function useAudioCapture(props?: {
  options?: Partial<V1SdkConfig>;
  autoStart?: boolean;
  language?: string; // additive, no v1 ancestor
  languageMode?: string; // additive, no v1 ancestor
  // Audio SOURCE selection (TASK-597) — additive, no v1 ancestor
  deviceId?: string;
  secondaryDeviceId?: string;
  additionalDeviceIds?: string[];
  sourceStreams?: MediaStream[]; // pre-built (e.g. file-backed) streams INSTEAD of getUserMedia
  sourceGains?: number[]; // per-source linear mixer gain, index-aligned with the resolved source list
  dynamicSources?: boolean; // build a mixer even for ONE source (TASK-609) — see the caveat below
  audioProcessing?: AudioProcessingConstraints; // browser echoCancellation/noiseSuppression/autoGainControl (TASK-608)
  // Stop-drain tuning (TASK-597 follow-up #4) — additive, no v1 ancestor
  drainTimeoutMs?: number;
  quietWindowMs?: number;
  onAudioData?: (data: ArrayBuffer) => void; // retained for source-compat only — NEVER invoked
  onError?: (error: ErrorInfo) => void;
}): {
  isRecording: boolean;
  deviceStatus: AudioDeviceStatus | null;
  sourceLevels: number[]; // additive, no v1 ancestor
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  getDeviceStatus: () => Promise<AudioDeviceStatus | null>;
  error: ErrorInfo | null;
  isReady: boolean;
  uplinkBitrate: number; // TASK-612 — live outbound STT uplink bitrate (bits/sec); 0 when not streaming
  audioLost: boolean; // TASK-612 — session-sticky latch: true once outbound audio was dropped this session
  droppedFrames: number; // TASK-612 — count of outbound audio frames dropped this session
};
```

**Behavior:**
- `startRecording()`/`stopRecording()` drive the **same shared `useArcaAudio()` instance** as `useArcaSpeechToText`, guarded by `audio.isCapturing` — pairing both hooks (as v1 apps typically do) never double-starts the mic.
- `startRecording()` calls `audio.start({ pipelineId: options?.sttPipelineId, language?, languageMode?, startOn?, deviceId?, secondaryDeviceId?, additionalDeviceIds?, sourceStreams?, sourceGains?, drainTimeoutMs?, quietWindowMs? })`. If a pre-start provider selection is pending (see `useArcaSttProvider` below), it's applied here as `startOn` and then cleared.
- `onAudioData` is accepted for source-compat but **never invoked** — v2 owns the full capture→mix→noise→VAD→STT pipeline and transport internally.
- `language`/`languageMode` are additive (no v1 ancestor). Because this hook and `useArcaSpeechToText` race to call `audio.start` first, **both** hooks also write the selection into the shared store (`setAudioLanguage`/`setSttLanguageMode`, read by `useArcaSpeechToText`) so the outcome is order-independent — whichever hook starts first, the selection isn't dropped.
- **Audio source selection (TASK-597)**, all additive/optional (omitting them keeps the frozen v1 behavior): `deviceId`/`secondaryDeviceId`/`additionalDeviceIds` pick real input devices; `sourceStreams` injects pre-built streams (e.g. file-backed) INSTEAD of `getUserMedia`; `sourceGains` sets a per-source linear mixer gain, index-aligned with the resolved source list. Unlike `languageMode`/`pendingSttProvider` there is **no store-backed fallback** for these — a `MediaStream` is a live, non-serializable resource, so ownership would become ambiguous if parked in the shared store. They're honored only when capture is started from **this hook** — the documented order for a capture-first consumer (the compat playground); `useArcaSpeechToText` never carries source options. Full ownership/liveness/troubleshooting contract for `sourceStreams`: [§8 External microphones & injected streams](#8-external-microphones--injected-streams).
- **`dynamicSources`** (TASK-609), forwarded verbatim to `audio.start(...)`: builds an `AudioMixer` even for a single capture source, so the mix could be changed mid-session (via runtime `addSource`/`removeSource`/`setSourceGain`) without tearing capture down. On the compat surface today this only pre-arms the mixer — those runtime methods live on the native `useArcaAudio()` only and are **not yet exposed through `/compat`** (OD-4, deferred to a follow-up ticket), so passing `dynamicSources: true` alone has no directly observable effect for a pure-compat consumer.
- **`audioProcessing`** (TASK-608), forwarded verbatim to `audio.start(...)` and applied to every capture source's `getUserMedia` constraints: `{ echoCancellation?, noiseSuppression?, autoGainControl? }`, each defaulting to the browser's own ON default when omitted. This is **not** the same switch as `V1SdkConfig.audioSettings.noiseSuppression` (which toggles the SDK's own RNNoise stage) — this one is the *browser's* DSP, which runs before the SDK ever sees a sample. **Ignored when `sourceStreams` is used** — see [§8](#8-external-microphones--injected-streams).
- **`sourceLevels`** (TASK-597 follow-up #2): PER-SOURCE input levels (0–100 each), index-aligned with the resolved capture-source order — with `sourceStreams` when streams are injected, otherwise with `[deviceId, secondaryDeviceId, ...additionalDeviceIds]`. REACTIVE (re-renders as levels change), unlike `getDeviceStatus()`, which still requires polling. `deviceStatus.audioLevel` is unchanged and remains the single MIXED level — the v1 shape stays frozen. `[]` means no per-source signal (not recording, or a runtime that cannot analyse) — attribution is then genuinely unknown. One entry means a single-source session, where that source is the whole mix and attribution to it is exact.
- **`uplinkBitrate` / `audioLost` / `droppedFrames`** (TASK-612 Lane E, additive): live diagnostics straight off the store, no polling. `uplinkBitrate` is the outbound STT uplink in bits/sec (`0` when not streaming). `audioLost` is a session-sticky latch that flips `true` once any outbound audio frame was dropped at the streaming transport's backpressure watermark — it survives reconnect and clears only on the next `startRecording()`. `droppedFrames` is the running count behind it. All three degrade to `0`/`false` when the underlying store field is unset (e.g. a test double), the same rule `sourceLevels` already follows.
- **`drainTimeoutMs`** (TASK-597 follow-up #4): ceiling (ms) on the streaming-STT stop-drain awaited by `stopRecording()`. Forwarded verbatim to `audio.start(...)`; omit for the SDK default (1500 ms). Non-positive values are ignored. The mic is released synchronously on stop regardless — this only bounds how long the returned promise waits for the server's last transcript.
- **`quietWindowMs`** (TASK-597): quiet window (ms) that ends the stop-drain early once the backend reports `finalizing`. Omit for the SDK default (250 ms). **`0` disables the early resolve** and is PRESERVED (only negative values are ignored) — set it to `0` with a generous `drainTimeoutMs` when the tail final matters more than teardown latency, since on a slow ASR pipeline the last transcript can trail `finalizing` by seconds.
- `getDeviceStatus()` uses `navigator.mediaDevices.enumerateDevices()`; `permissionStatus` is inferred `'granted'` only when at least one returned device has a non-empty `label` (Chrome only populates labels post-permission).
- `autoStart: true` calls `startRecording()` once on mount.

## 3. `useArcaSpeechToText`

The most nuanced compat hook — reproduces v1's push-style `onTranscript` callback over v2's pull-state transcript model.

```ts
function useArcaSpeechToText(props: {
  sessionId: string;
  language: string;
  options?: Record<string, unknown>; // pipelineId, languageMode read from here (additive)
  transcriptTemplate?: string; // default: "{timestamp} {speaker_id}: {text}"
  onTranscript: (text: string, isFinal: boolean, metadata?: Record<string, unknown>) => void;
  onError?: (error: ErrorInfo) => void;
  onStatus?: (status: string, data?: unknown) => void;
}): {
  transcript: string;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
  sendAudioData: (audioData: ArrayBuffer, metadata?: Record<string, unknown>) => void;
  uploadAudioFile: (file: File, language: string, provider?: string) => Promise<string>; // → job id
  getTranscriptionStatus: (taskId: string) => Promise<unknown>; // → TranscriptionJobResponse
  isUploading: boolean;
  uploadProgress: number; // 0–100
  error: ErrorInfo | null;
};
```

### How the callback is synthesized

v1 pushed transcripts over a WebSocket into `onTranscript`; v2 exposes `transcriptSegments[]` (final) and `currentTranscript` (interim) as store state. This hook diffs those selectors on every render:
- Each **new final segment** → `onTranscript(text, true, metadata)`, with `text` run through `transcriptTemplate`.
- A **changed interim value** → `onTranscript(text, false, metadata)`, with `text` delivered **raw** (interims have no speaker/timestamp — the template's `{speaker_id}`/`{timestamp}` slots would be meaningless).

### `sendAudioData` — a metadata sink, never an audio sink

```ts
sendAudioData(audioData: ArrayBuffer, metadata?: Record<string, unknown>): void
```
- **Never transmits `audioData`.** v2 owns capture and transport end-to-end; this call exists purely so v1 call sites keep compiling.
- Records `metadata` onto a **bounded, capture-relative timeline** (cap **256** entries, drop-oldest), keyed by `atMs = Date.now() - captureStartMs`. `captureStartMs` is anchored at `startTranscription()` and reset at `stopTranscription()`.
- **8 KiB guard:** throws `"Audio frame metadata exceeds 8192 bytes"` if `JSON.stringify(metadata).length > 8192` (v1 `MAX_METADATA_BYTES` parity).

### Delivered-metadata precedence (frozen contract)

Composed in `speechToTextMetadata.ts#composeDeliveredMetadata`, in this exact order — **lowest to highest**:

```ts
{
  // (1) v2 enrichments — LOWEST precedence
  speaker_id: seg.speakerLabel, confidence: seg.confidence, language: seg.language,
  startTime: seg.startTime, endTime: seg.endTime, isFinal,
  // (2) your own metadata — OVERRIDES the enrichments above
  ...callerMeta,
  // (3) normalized v1-canonical keys — HIGHEST precedence, overlaid last
  ...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
  ...(detectedLanguage !== undefined ? { detected_language: detectedLanguage } : {}),
}
```

In short: **if you set `speaker_id`/`confidence`/`language`/`isFinal` yourself, your value wins.** Only `chunk_id` and `detected_language` are always overlaid on top from their normalized sources.

- **`chunk_id` normalization:** `metadata.chunk_id` → `metadata.chunkId` → `metadata.other` (first defined wins).
- **`detected_language` normalization:** `metadata.detected_language` → `metadata.detectedLanguage` → `seg.language` (v2's session-configured language — genuine per-utterance detection only where the backend actually populates `seg.language`, e.g. Sarvam code-switch).

### Correlation model (coarse, not byte-exact)

- **Final segments** pick the timeline entry with the **latest `atMs` that is ≤ `startTime * 1000`**; if none precedes it (or the time base is unavailable), it falls back to the most-recent entry (sticky).
- **Interim segments** always use the **most-recent** entry (sticky) — there's no reliable time window for an in-progress utterance.
- This matches v1's own documented guarantee: coarse, utterance-level correlation, never byte-exact.

### Other behavior

- `pipelineId` and `languageMode` are read out of the frozen `options` bag (additive, no v1 signature change) and forwarded to `audio.start(...)`.
- `startTranscription()`/`stopTranscription()` drive the **same** `useArcaAudio()` instance as `useAudioCapture`, guarded by `audio.isCapturing` — idempotent when paired.
- `uploadAudioFile()` / `getTranscriptionStatus()` / `isUploading` / `uploadProgress` are **live** (TASK-603) — they used to throw / be hardcoded. See §3.1 below.
### 3.1 File upload — the v1 members, for real (TASK-603)

```ts
const taskId = await uploadAudioFile(file, 'ml');           // → job id
const job = await getTranscriptionStatus(taskId);           // → TranscriptionJobResponse
```

- Uploads to `POST /api/v1/audio/transcription-jobs/transcribe` (multipart) through `FileTranscriptionService`, and resolves to the **job id** — v1 resolved to its task id, so the call site is unchanged.
- **`provider` is a pipeline override.** v1's third argument was an ASR provider name (`'azure' | 'whisper'`); v2 expresses the engine as a pipeline, so a non-empty `provider` is used as the `pipelineId` for that upload. Omitted, the pipeline comes from `options.pipelineId` — the same value the live path uses. Neither present rejects with a named error; nothing is uploaded against a guessed engine.
- `isUploading` / `uploadProgress` (0–100) track the in-flight upload; a failure also lands on `error` and calls `onError`.
- This pair is **single-file**, exactly as v1 shaped it. For many files with per-file progress and live streamed results, use [`useArcaBatchTranscription`](#7-usearcabatchtranscription).

- `onStatus` (a previously-frozen-but-unwired v1 prop) also fires `'reconnecting'`/`'reconnected'` on transport reconnects, `'provider_switched'` with `{ fromPipeline, toPipeline }` on any STT engine switch, and — TASK-612 Lane D — `'no_audio_signal'` when the silent-uplink watchdog detects a sustained zero-level streaming session, followed by `'audio_signal_restored'` on recovery. Each of that pair fires **once per transition, never on mount**. See [§8 External microphones & injected streams](#8-external-microphones--injected-streams) for what trips the watchdog and how long it takes. All of the above is additive behavior on an existing optional prop; apps that never pass `onStatus` are unaffected.

## 4. `useText`

v1 summary hook, reproduced against the gateway's v1-compat TEXT shim (`apps/api`'s `text-compat` module, `@Controller('api/smr/api/v1')`).

```ts
function useText(props?: {
  sessionId?: string;
  onComplete?: (summary: SummaryResponse) => void;
  onError?: (error: ErrorInfo) => void;
}): {
  summarize: (request: TextRequest) => Promise<SummaryResponse>; // alias of summarizeSync
  summarizeSync: (request: TextRequest) => Promise<SummaryResponse>;
  summarizeAsync: (request: TextRequest) => Promise<TextJobStatus>; // best-effort, not part of the frozen v1 contract
  preSummarize: (request: PreSummaryRequest) => Promise<PreSummaryResponse>;
  loading: boolean;
  error: string | null;
};
```

**Endpoints (literal v1 paths, deliberately outside the gateway's `/api/v1` prefix):**

| Call | Path |
| --- | --- |
| `summarize` / `summarizeSync` | `POST /api/smr/api/v1/summary/sync` |
| `preSummarize` | `POST /api/smr/api/v1/presummary` |
| `summarizeAsync` | `POST /api/smr/api/v1/summary/async` |

**Behavior:**
- The request origin is derived from `AgenticClient.getBaseUrl()` with the trailing `/api/v1` stripped, then re-appended as `/api/smr/api/v1/...` — because these shim paths live outside the normal gateway prefix. Requests go through a raw `fetch`, **not** `AgenticClient.post` (which always prepends `/api/v1`). Auth is `x-api-key`, read from the same `AgenticClient` the provider configured.
- **Real per-turn `conversation_segments`** are always built — from `request.segments` when supplied, otherwise split from `request.text` per non-empty line (a fixed v1 defect: v1 collapsed the entire transcript into one `speaker: 'user'` blob). Lines shaped `"Speaker: text"` (speaker name ≤ 40 chars before the colon) are parsed to keep the speaker label; everything else defaults to `speaker: 'user'`.
- `summarizeAsync` calls `/summary/async`, which is **explicitly not part of the reproduced v1 shim contract** — treat it as best-effort and prefer `summarizeSync`.
- **Tenant context is mandatory** — the endpoint rejects with `401 "Tenant context is required"` if no tenant resolves from the API key / `X-Tenant-Id`. There is no v1-style SYSTEM-tenant default fallback.
- **DNA writing-style (TASK-599):** set `TextRequest.doctorId` (summary) or `PreSummaryRequest.doctorId` to forward a top-level `doctor_id` alongside the legacy `session_data.session_metadata.doctor_id`. When the tenant+doctor DNA gate is on, the gateway applies that doctor's DNA writing-style to the prompt; omitted ⇒ department + visit-type prompting only, unchanged from before TASK-599.
- **Translate-to-English (TASK-600):** set `TextRequest.translateToEnglish: true` to have the gateway translate the transcript to English via Sarvam **before** summarizing — sent on the wire as top-level `translate_to_english: true` (omitted when unset/false). **Summary-only** — there is no pre-summary equivalent. **Fail-open:** if translation fails, the gateway summarizes the original transcript rather than erroring. When translation succeeds, the gateway also forces the summary's output-language directive to English, overriding whatever language the source session was tagged with.
- **Streaming (opt-in):** pass `{ stream: true, onDelta }` on `TextRequest`/`PreSummaryRequest`. The hook switches to SSE parsing:
  - `event: delta` (`data: {"text": "..."}`) → fires `onDelta(delta, accumulated)`, where `accumulated` is the running concatenation including this delta.
  - `event: reasoning` (`data: {"text": "..."}`) → fires `onReasoning(reasoning, accumulated)` when supplied, on a channel kept **separate** from `onDelta`/the final result. A reasoning-capable model's chain-of-thought (Azure `reasoning_content`, Anthropic thinking blocks, LM Studio reasoning deltas) lands here — never mixed into the answer text. Callers that don't pass `onReasoning` simply never see these frames; nothing else changes.
  - `event: result` → resolves the promise with the same v1-shaped body the non-streaming path returns.
  - `event: error` (`data: {"detail": "..."}`) → rejects with that detail message.
  Omitting `stream` (or setting it `false`) is **byte-identical** to the existing single-JSON-response path — nothing changes for callers who don't opt in.
- **Reasoning models on the non-streaming path too:** even without `stream:true`, a model that inlines its chain-of-thought as `<think>…</think>`/`<thinking>…</thinking>` ahead of the JSON answer has those blocks stripped server-side before parsing (and, failing a direct parse, the gateway falls back to extracting the last brace-balanced `{...}` object) — so a reasoning model's preamble no longer breaks summary parsing.
- **BYOK credential errors (TASK-602):** the gateway no longer holds env-level cloud-provider credentials — a tenant's Azure/OpenAI/Anthropic selection (primary or fallback) must have a BYOK connection configured, or the call fails closed with a `503` (`ProviderCredentialsError`) surfaced through the normal `onError`/thrown-`Error` path. Local engines (LM Studio/Ollama) are unaffected.
- **`max_tokens` ceiling:** both `TextRequest`/`PreSummaryRequest` map to a gateway DTO capped at `1–32768` (raised from `32000`); a value outside that range is rejected by the gateway's validation pipe before it reaches the LLM.

## 5. `useArcaSttProvider`

The **one compat hook with no v1 ancestor** — v1 never had STT provider switching. A thin adapter over `useArcaAudio()`'s public `activePipeline`/`sttConnectionState`/`switchProvider()` — no store internals, no client ownership.

```ts
function useArcaSttProvider(props?: {
  onProviderSwitched?: (info: ProviderSwitchInfo) => void; // fires on EVERY switch, either direction, auto or user
  onSwitchFailed?: (error: ErrorInfo) => void; // fires only when a USER-requested switch fails
}): {
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  fallbackAvailable: boolean;
  isFallbackActive: boolean;
  usePipeline: boolean; // true = on the SDK-configured primary; false = on the tenant default
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
  switchToFallback: () => Promise<void>; // alias of switchToDefault, kept for pre-586 callers
  switchToPipeline: () => Promise<void>; // requires enableProviderSwitch: true
  switchToDefault: () => Promise<void>;
};
```

**Behavior:**
- Bidirectional toggle (TASK-586): **ON** (`usePipeline: true`) = the SDK-configured (primary) pipeline; **OFF** = the tenant-admin default (fallback) provider.
- **`switchToPipeline()`** (switching **back** to primary) requires `enableProviderSwitch: true` on `<ArcaCompatProvider>` — without it, it rejects with `ErrorInfo.code === 'SWITCH_FAILED'` (the native streaming route has no primary-direction endpoint; only the compat gateway shim `POST /api/stt/switch` supports switching back).
- **Idempotent in both directions** — calling `switchToDefault()` while already on the fallback (or `switchToPipeline()` while already on primary) resolves immediately without a second backend call.
- **Pre-start selection:** if called **before capture starts**, the target is recorded in the store (`pendingSttProvider`) instead of switching, and is applied automatically as `startOn` at the next `audio.start(...)` call by whichever start-hook (`useAudioCapture` or `useArcaSpeechToText`) runs first.
  - The gate is **`audio.isCapturing`**, not `activePipeline` (TASK-614). During capture the live switch is always issued — including when the SDK does not know which pipeline is running, which is the normal state for a session started without an explicit `pipelineId`. Before TASK-614 that state was mistaken for "capture hasn't started", so a mid-session toggle silently recorded a preference and reported `switched` while sending nothing.
- **A switch that was not performed is never reported as one.** During capture with no backend streaming session behind it (local/browser STT, or a transport that never came up), both methods reject with `ErrorInfo.code === 'SWITCH_UNSUPPORTED'`.
- `onProviderSwitched` fires for **every** switch in **either** direction — both an automatic switch (e.g. a backend provider outage) and a user-initiated one. The delivered `reason` is `'auto'` or `'user'`.
- **Direction is read, not guessed** (TASK-614). The backend's `provider_switched` frame relays `active`/`is_fallback`; where a backend omits both, the SDK compares the reported pipeline against the requested one before falling back to assuming a fallback. Previously the absent-fields case always assumed "fallback", so a switch **back** to the selected pipeline never un-latched.
- **`activePipeline` is server-derived** (TASK-614): it comes from the session-create response (the RESOLVED pipeline + the engine actually opened on), so it is non-null for every backend streaming session — including one started with no `pipelineId` — and reports `isFallback: true` from frame 0 when the session opened on the fallback (by `startOn`, or because the primary ASR failed to load). Against a gateway that predates the echo it degrades to the old request-derived value.

### Automatic fallback

Failure-driven fallback is **backend-owned and needs no client code**. When the tenant has a fallback pipeline configured, the STT service switches the live session's ASR engine after a classified failure (immediately on auth/quota errors, after N consecutive failures otherwise) and the client is told via `onProviderSwitched` with `reason: 'auto'`. Tenants govern it with `autoSwitchEnabled` / `consecutiveFailureThreshold` on their STT config. The same applies to **batch**: a cloud-ASR/model failure re-runs the job once on the tenant fallback, and `BatchQueueItem.usedFallbackPipelineId` names the pipeline that actually produced the transcript.

## 6. `useArcaSttLanguageModes`

A **v2-native hook with no v1 ancestor**, re-exported from `/compat` purely so it shares an entry bundle with `ArcaCompatProvider` (see [Entry-bundle isolation](#entry-bundle-isolation) — importing it from `/core` inside a compat tree throws).

```ts
function useArcaSttLanguageModes(autoFetch?: boolean): {
  modes: LanguageMode[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

interface LanguageMode {
  id: string; // pass to audio.start({ languageMode: id })
  label: string; // e.g. "Malayalam + English"
  kind: 'single' | 'code_switch' | 'auto';
  primaryLanguage: string | null; // ISO 639-1, or null for auto-detect
}
```

Fetches `GET /audio/transcription-jobs/language-modes` (default: once on mount, or lazily via `refresh()` if `autoFetch: false`). The selected mode's `id` is passed to `audio.start({ languageMode })`; the backend is authoritative — it rejects with **422** if no configured engine can serve the requested mode.

## 7. `useArcaBatchTranscription`

A **v2-native hook with no v1 ancestor** (same category as `useArcaSttProvider`), for transcribing PRE-RECORDED files. v1 only had the single-file `uploadAudioFile()` on `useArcaSpeechToText` — still supported, see [§3.1](#31-file-upload--the-v1-members-for-real-task-603) — this is the multi-file queue: per-file upload progress, per-file live results, cancel/retry.

```ts
function useArcaBatchTranscription(props?: {
  options?: { pipelineId?: string; language?: string; consultationId?: string }; // defaults per enqueue
  concurrency?: number; // default 2 — bounds uploads AND open SSE streams
  onJobCompleted?: (item: BatchQueueItem) => void;
  onError?: (error: ErrorInfo, itemId: string) => void;
}): {
  items: BatchQueueItem[];
  enqueue: (files: File[] | FileList, options?: BatchTranscriptionOptions) => string[]; // → queue-item ids
  cancel: (itemId: string) => void;
  retry: (itemId: string) => void;
  remove: (itemId: string) => void;
  clear: () => void;
  isUploading: boolean;
  isStreaming: boolean;
  activeCount: number;
  error: ErrorInfo | null;
};

interface BatchQueueItem {
  id: string; // queue id (NOT the job id — that exists only after upload)
  fileName: string;
  size: number;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';
  uploadProgress: number; // 0–100, upload only
  jobId: string | null;
  segments: BatchTranscriptSegment[]; // streamed, in arrival order
  text: string; // joined finals while streaming; the job's own resultText once completed
  error: string | null;
  job: TranscriptionJobResponse | null;
}
```

```tsx
const batch = useArcaBatchTranscription({ options: { pipelineId, language: 'ml-en' } });
<input type="file" multiple accept="audio/*" onChange={(e) => batch.enqueue(e.target.files ?? [])} />;
```

### How it runs

1. `POST /audio/transcription-jobs/transcribe` (multipart, XHR progress) → job id.
2. `GET /audio/transcription-jobs/:id/stream` (SSE) → `chunk` / `status` / `complete` / `error` events append to `segments`.
3. On terminal completion the job is **re-read once** (`GET /audio/transcription-jobs/:id`) and `item.text` becomes its `resultText` — streamed chunks can be partial, so the read-back is the authoritative transcript.

### Two things that are easy to get wrong

- **SSE construction is `new SSEClient(scope, apiClient, logger)`.** The legacy one-argument form is blocked inside the client and never connects.
- **The ticket scope is per job — `transcription_job:<jobId>`** (`transcriptionJobScopeFor()`), because the route declares `@StreamScope({ namespace: 'transcription_job', param: 'id' })`. A generic scope string is rejected 401.

Both are locked by unit tests; do not "simplify" either.

### Concurrency

A slot is held for the **whole lifecycle** — upload AND result stream — not just the upload, so `concurrency` also bounds how many SSE connections are open at once. Files past the cap sit in `pending` until a slot frees.

## 8. External microphones & injected streams

TASK-612 hardened the `sourceStreams` seam (§2) end to end — the "I pass my
own `MediaStream`(s) and get empty/no transcripts" class of v1→v2 migration
bug. This section is the full contract; §2/§3 above link back here for the
specifics. Ownership and liveness are enforced in `useArcaAudio`
(`@arcaai/vox`, non-compat) and `AudioMixer` (`@arcaai/room`) — compat only
inherits the behavior through `useAudioCapture`/`useArcaSpeechToText`.

### Start order — capture-shaped options must win the start race

`useAudioCapture` and `useArcaSpeechToText` drive the SAME `useArcaAudio()`
instance (see the coordination note atop §2/§3); only the hook whose
`audio.start(...)` call actually runs FIRST has its options applied. Always
call `startRecording()` — carrying `sourceStreams`/`deviceId`/etc. — **before**
`startTranscription()`, never the reverse; `startTranscription()` never
carries source options.

Since TASK-612 (Lane C), getting this backwards is no longer silent in the
tested case: when a start reaches `useArcaAudio` while capture is already
active AND carries capture-shaped options (`deviceId`, `secondaryDeviceId`,
`additionalDeviceIds`, `sourceStreams`, `sourceGains`, `audioProcessing`,
`dynamicSources`), it now REJECTS with `AgenticError('CAPTURE_OPTIONS_DROPPED', ...)`
naming every dropped key, instead of only `logger.warn`ing as before (the verified
case: `startTranscription()` first, `startRecording({ sourceStreams })` second).
The rejection surfaces through `useAudioCapture`'s existing `catch` →
`setError`/`onError` path — no new wiring needed. A call carrying only options
the running session already applies (`language`, `pipelineId`) is unaffected
and still resolves silently — that's the designed coordinated dual-hook start,
not a mistake.

### Stream ownership

An injected stream — `sourceStreams` on `useAudioCapture`, or the native
`useArcaAudio().addSource({ stream })` — is always **caller-owned**. Since
TASK-612 (Lane B, OD-1a) the SDK never stops a caller-owned stream's tracks:
`stopRecording()`, a failed `startRecording()`, and mixer
removal/`dispose()` all unwire the stream from the capture graph but leave
its tracks `live`. **The same `MediaStream` object can be handed to the next
`startRecording()` and will simply work** — reuse across sessions is
supported.

The corollary: releasing an injected stream's microphone is the **caller's**
job. If you built it from `getUserMedia` yourself, call `track.stop()` on it
when you are truly done — the SDK will not do it for you, and forgetting it
leaves the browser's recording indicator lit after `stopRecording()`.

Streams the SDK itself opens — every `deviceId`/`secondaryDeviceId`/
`additionalDeviceIds` source (i.e. any capture that does not pass
`sourceStreams`) — are SDK-owned and released by SDK teardown exactly as
before TASK-612; nothing changes for device-id capture.

### Liveness — a dead or trackless stream rejects, it never streams silence

Every entry in `sourceStreams` (and the stream passed to the native
`addSource({ stream })`) must have at least one audio track with
`readyState === 'live'` at start. Since TASK-612 (Lane A) a stream that fails
this — no audio track at all, or every track already `ended` (the classic
symptom of reusing a stream the SDK used to kill, pre-Lane-B) — is rejected
BEFORE anything is armed: no `getUserMedia` call, no teardown-sensitive state
registered, nothing to unwind.

`startRecording()` rejects with `AgenticError('SOURCE_STREAM_NOT_LIVE', ...)`,
the message naming every offending entry by index — e.g.
`sourceStreams[0]: no live audio track` — so several bad entries are all
named in one rejection. The native `addSource({ stream })` seam applies the
identical check but names the stream generically
(`useArcaAudio.addSource: injected stream has no live audio track.`), since
there is only ever one candidate there.

### `sendAudioData` still does not send audio

`sendAudioData(audioData, metadata)` still never transmits `audioData` — it
is a metadata sink only (§3, unchanged by TASK-612). If your v1 app captured
its own PCM and pushed it here expecting it on the wire, that is the **RC-1**
migration trap: your audio was silently discarded while v2 captured a
*different* source (the OS default mic, or nothing). **Pass your stream(s) to
`useAudioCapture({ sourceStreams: [...] })` instead** — that's the only way
to get your own audio captured; `sendAudioData` cannot recover it after the
fact, and `onAudioData` never fires either way.

### Virtual/loopback devices and browser DSP

On the `deviceId` path (not `sourceStreams`), the browser's own
audio-processing module — echo cancellation, noise suppression, AGC, all ON
by default in Chrome/Edge/Safari — runs before the SDK ever sees a sample,
and on virtual or loopback devices with non-standard clocking it can emit
**pure silence** instead of erroring (RC-4). If a virtual/loopback `deviceId`
capture streams zeros, pass:

```ts
useAudioCapture({
  deviceId: virtualDeviceId,
  audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
});
```

`audioProcessing` (§2) is **ignored when `sourceStreams` is used** — those
streams were already built by the caller, who owns their own constraints;
there is nothing for the SDK to apply it to.

### `pipelineId` is required for live backend STT

Live backend STT requires a `pipelineId` — set it via
`useAudioCapture({ options: { sttPipelineId } })`, or forward one through
`useArcaSpeechToText({ options: { pipelineId } })`. Without it, capture still
starts (`isRecording`/`isCapturing` go `true`, the mic is live) but no
streaming transport is built and no socket opens — nothing ever reaches
`onTranscript`/`transcriptSegments` (RC-5). **This was not addressed by
TASK-612** — see the troubleshooting table below. Check
`useArcaSttProvider().activeProvider` (`null` ⇒ no pipeline) or the native
`store.activePipeline`.

### The silent-uplink watchdog

A watchdog (TASK-612 Lane D) runs on every streaming session (one that
supplied a `pipelineId`). If the input level stays at zero for **5
consecutive seconds** while unmuted, the session is declared silent:
`onStatus('no_audio_signal')` fires once (§3), the native store's
`audioSignalState` flips to `'silent'`, and one `logger.warn` names the
likely causes — a wrong/default microphone, an OS-muted device, a suspended
caller `AudioContext` behind an injected stream, or browser
echo-cancellation/noise-suppression/AGC zeroing a virtual device. The first
non-zero level clears it — `onStatus('audio_signal_restored')` fires once —
and the watchdog re-arms for a fresh 5 s window.

Muting (`audio.mute()`) is exempt: an intentionally-muted session never trips
the watchdog, and unmuting always gets a fresh full window before any
warning. The watchdog rides the same live input-level meter `sourceLevels`
does, so it is unavailable wherever that meter is.

### Import every hook from `/compat`

This whole contract lives inside `useArcaAudio`, but you never import
`useArcaAudio` yourself under `<ArcaCompatProvider>` — every hook you use in
that tree, `useAudioCapture`/`useArcaSpeechToText` included, must come from
`@arcaai/vox/compat` (see [Entry-bundle isolation](#entry-bundle-isolation)).
Importing any hook from `/core` or `/plugins` instead reads a different store
context and throws.

### Troubleshooting

Adapted from the TASK-612 root-cause investigation, updated to post-fix
reality:

| Observable | Cause | Since TASK-612 |
| --- | --- | --- |
| `startRecording()` (or the native `addSource()`) rejects `SOURCE_STREAM_NOT_LIVE` | A `sourceStreams[i]` (or the single `addSource({stream})`) has no audio track, or none `live` | **New** — was RC-3's silent zero-uplink; now a loud rejection before anything is armed |
| `startRecording()` rejects `CAPTURE_OPTIONS_DROPPED` | Called after `startTranscription()` already started capture, carrying `sourceStreams`/`deviceId`/etc. — the start race (RC-2) | **New** — was a `logger.warn`-only silent drop |
| `onStatus('no_audio_signal')` fires; binary frames flowing but payloads are all zero | Wrong/default mic, muted device, suspended caller `AudioContext`, or browser APM zeroing a virtual device (RC-1 / RC-4) | **New signal** — was previously only visible by watching `sourceLevels` stay `[0]` |
| No binary frames at all; only JSON `ready`/`status` | A capture source's track ended mid-session (device unplugged/revoked) — check `track.readyState === 'ended'` | Unchanged — surfaced via `audio.error`; the dead-AT-START class (old RC-3) is now a start-time rejection instead |
| No socket at all | No `pipelineId` was supplied (RC-5) — check `activeProvider` / `store.activePipeline` | **Unchanged** — not addressed by TASK-612 |
| Debug log `Using caller-supplied source streams` absent | Your streams never reached `startAudio` — check the start-order rule above | Unchanged |
| A `sourceStreams` `MediaStream` reused across sessions used to go dead | Pre-612 the SDK stopped every injected track on `stop()` (RC-3) | **Fixed** (Lane B, OD-1a) — caller-owned tracks now survive `stopRecording()`; reuse just works |

**`ErrorInfo.code` stays coarse.** Every compat hook's `onError`/`.error`
wraps whatever was thrown into one of two fixed codes —
`useAudioCapture` always reports `'AUDIO_CAPTURE_ERROR'`,
`useArcaSpeechToText` always reports `'TRANSCRIPTION_ERROR'` — regardless of
the underlying `AgenticError.code` (`SOURCE_STREAM_NOT_LIVE`,
`CAPTURE_OPTIONS_DROPPED`, etc.). The specific code travels only in
`ErrorInfo.message`. To branch on the precise code programmatically, catch
the promise from `startRecording()`/`startTranscription()` directly — both
re-throw the original error after populating `error`/`onError`, so
`(err as { code?: string }).code` is there for a caller who wants it.
`AgenticError` itself isn't re-exported from `/compat`; a `import type` from
`@arcaai/vox`/`@arcaai/vox/core` for a stricter cast is fine (type-only
imports carry no runtime store dependency, so the entry-bundle isolation rule
above — which is about hooks — doesn't apply to them).

## 9. Reproduced v1 type surface

`compat.ts` re-exports the following types verbatim from the frozen v1 contract (`compat/types.ts`), so a v1 app keeps compiling against familiar names:

`V1SdkConfig`, `V1AudioSettings`, `ErrorInfo`, `SessionStatus`, `MedicalSession`, `SessionMetadata`, `PatientInfo`, `ProviderInfo`, `AudioDeviceStatus`, `SummaryResponse`, `MedicalSummary` (union of `EnhancedMedicalSummary | SimplifiedMedicalSummary | SoapMedicalSummary`), `EnhancedMedicalSummary`, `SimplifiedMedicalSummary`, `SoapMedicalSummary`, `TextRequest`, `TextJobStatus`, `ConversationSegmentInput`, `TestResult`, `PreviousVisitRecord`, `PreSummaryRequest`, `PreSummaryResponse`, `StructuredPreSummary`, `PreSummarySection`, `PreSummarySectionItem`, `ProviderSwitchInfo`.

`TextRequest`/`PreSummaryRequest` themselves are frozen shapes (TASK-560 §5), but keep growing ADDITIVE, no-v1-ancestor fields with no effect on callers who omit them: `stream`/`onDelta` (TASK-589), `onReasoning` (streaming reasoning-model chain-of-thought), `doctorId` (TASK-599 — DNA writing-style), and `translateToEnglish` on `TextRequest` only (TASK-600 — Sarvam translate-before-summarize).

`ErrorInfo` shape (used across every compat hook's `onError`):
```ts
interface ErrorInfo {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'network' | 'audio' | 'processing' | 'authentication' | 'configuration';
  details?: Record<string, unknown>;
  stack?: string;
}
```

## 10. Defects/anti-patterns deliberately not reproduced

Documented in [`TASK-560 README §6`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/README.md):

| Id | v1 behavior | Why it's not reproduced |
| --- | --- | --- |
| A1 | Hardcoded default `apiKey`/`encryptionKey` when config omitted them | `mapV1ConfigToAgenticConfig` throws instead — a real key is always required |
| F1 | Binary WS audio frames could arrive corrupted | Moot — v2 owns transport entirely; `sendAudioData` never sends audio |
| F2 | Whole transcript collapsed into one `speaker: 'user'` conversation segment | `useText` always builds real per-turn segments |
| I1 | Two unrelated session ids used interchangeably | v2 has one canonical `Consultation.id` |
| I2 | No confidence score on v1 transcripts | v2's `TranscriptSegment.confidence` is exposed in delivered metadata |

## Related docs

- [`Batch-Transcription-Reference.md`](Batch-Transcription-Reference.md) — expanded batch transcription reference: the compat hook contracts in §3.1/§7 above, plus the full gateway REST/SSE API (`TranscriptionJobController`) they call
- [`../README.md`](../README.md) — full SDK overview (core hooks, audio pipeline, session lifecycle)
- [`docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md) — step-by-step migration walkthrough with a full before/after example
- [`docs/implementation/TASK-560-v1-v2-consultation-migration/README.md`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/README.md) — frozen contract (§5) and anti-patterns (§6)
- [`docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md`](../../../docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md) — the live-transcription metadata contract in full
- [`docs/implementation/TASK-599-Compat-DNA-Writing-Style/README.md`](../../../docs/implementation/TASK-599-Compat-DNA-Writing-Style/README.md) — DNA writing-style resolution into TEXT summary/pre-summary prompts
- [`docs/implementation/TASK-600-Compat-Translate-To-English/README.md`](../../../docs/implementation/TASK-600-Compat-Translate-To-English/README.md) — Sarvam translate-to-English before summarizing
- [`docs/implementation/TASK-602-Provider-Credential-Env-Fallback-Cleanup/README.md`](../../../docs/implementation/TASK-602-Provider-Credential-Env-Fallback-Cleanup/README.md) — BYOK cloud-provider credential model (fail-closed `ProviderCredentialsError`)
- [`apps/compat-playground`](../../../apps/compat-playground) (port 5177) — full runnable reference app exercising every hook on this page

## Source file index

| File | Contents |
| --- | --- |
| `src/compat.ts` | Entry point / barrel |
| `src/compat/ArcaCompatProvider.tsx` | Provider + `CompatFeatureFlagsContext` |
| `src/compat/config-adapter.ts` | `mapV1ConfigToAgenticConfig` |
| `src/compat/useArcaSessionManager.ts` | + `mapV2StatusToV1` |
| `src/compat/useAudioCapture.ts` | |
| `src/compat/useArcaSpeechToText.ts` | |
| `src/compat/speechToTextMetadata.ts` | Pure metadata helpers (`composeDeliveredMetadata`, `pickMetadataForFinal`, etc.) |
| `src/compat/useText.ts` | |
| `src/compat/useArcaSttProvider.ts` | |
| `src/compat/useArcaBatchTranscription.ts` | Batch/file upload queue (TASK-603) |
| `src/hooks/useArcaSttLanguageModes.ts` | Re-exported via `compat.ts` |
| `src/compat/types.ts` | Reproduced v1 type surface |
| `src/compat/__tests__/` | Unit tests for every hook above, plus `contract.test.ts` and `metadata-passthrough.contract.test.ts` |
