# @arcaai/vox/compat — API Reference

**Package**: `@arcaai/vox` &middot; **Entry point**: `@arcaai/vox/compat` &middot; **Version**: 2.0.0

> Verified directly against source in `packages/agentic-sdk-v2/src/compat/` (2026-07-31).
> This document covers **only** the v1-compat surface. For the rest of the SDK
> (core hooks, audio pipeline, session lifecycle), see
> [`../README.md`](../README.md) and [`API-Reference.md`](API-Reference.md).

## Table of Contents

- [Purpose](#purpose)
- [Entry-bundle isolation](#entry-bundle-isolation)
- [Setup — `ArcaCompatProvider`](#setup--arcacompatprovider)
- [1. `useArcaSessionManager`](#1-usearcasessionmanager)
- [2. `useAudioCapture`](#2-useaudiocapture)
- [3. `useArcaSpeechToText`](#3-usearcaspeechtotext)
- [4. `useSMR`](#4-usesmr)
- [5. `useArcaSttProvider`](#5-usearcasttprovider)
- [6. `useArcaSttLanguageModes`](#6-usearcasttlanguagemodes)
- [7. Reproduced v1 type surface](#7-reproduced-v1-type-surface)
- [8. Defects/anti-patterns deliberately not reproduced](#8-defectsanti-patterns-deliberately-not-reproduced)
- [Related docs](#related-docs)
- [Source file index](#source-file-index)

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
| `audioSettings?` | `V1AudioSettings` | `{ sampleRate?, format?, channels?, noiseSuppression?, echoCancellation?, autoGainControl? }`. Only `noiseSuppression` is currently mapped (→ `audio.noiseFilter.enabled`, level fixed at `'medium'`). |
| `environment?` | `'development' \| 'staging' \| 'production'` | `'development'` → `debug: true`. |
| `sttPipelineId?` | `string` | Backend ASR pipeline id for live streaming. v1 had no equivalent (its STT WS was API-key-flat); omit for local STT. |
| `tenantId?` | `string` | TASK-586 addition. Accepted for parity; the v2 gateway resolves tenancy **authoritatively from the API key** — a mismatched value here is never trusted over the key. |
| `enableProviderSwitch?` | `boolean` | TASK-586 addition, default `false`. `true` lets `useArcaSttProvider().switchToPipeline()` switch **back** to the SDK-configured pipeline via the compat gateway's `POST /api/stt/switch` shim. `false`/omitted limits switching to the one-way TASK-567/568 fallback route. |

`ArcaCompatProvider` maps `options` via `mapV1ConfigToAgenticConfig` and renders
`<AgenticProvider config={...}>` underneath — it is a drop-in replacement for a
v1 provider, not a second store. `enableProviderSwitch` also rides a small
internal `CompatFeatureFlagsContext`, consumed only by `useArcaSttProvider`
(not part of the public API).

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
  onAudioData?: (data: ArrayBuffer) => void; // retained for source-compat only — NEVER invoked
  onError?: (error: ErrorInfo) => void;
}): {
  isRecording: boolean;
  deviceStatus: AudioDeviceStatus | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  getDeviceStatus: () => Promise<AudioDeviceStatus | null>;
  error: ErrorInfo | null;
  isReady: boolean;
};
```

**Behavior:**
- `startRecording()`/`stopRecording()` drive the **same shared `useArcaAudio()` instance** as `useArcaSpeechToText`, guarded by `audio.isCapturing` — pairing both hooks (as v1 apps typically do) never double-starts the mic.
- `startRecording()` calls `audio.start({ pipelineId: options?.sttPipelineId, language?, languageMode?, startOn? })`. If a pre-start provider selection is pending (see `useArcaSttProvider` below), it's applied here as `startOn` and then cleared.
- `onAudioData` is accepted for source-compat but **never invoked** — v2 owns the full capture→mix→noise→VAD→STT pipeline and transport internally.
- `language`/`languageMode` are additive (no v1 ancestor). Because this hook and `useArcaSpeechToText` race to call `audio.start` first, **both** hooks also write the selection into the shared store (`setAudioLanguage`/`setSttLanguageMode`, read by `useArcaSpeechToText`) so the outcome is order-independent — whichever hook starts first, the selection isn't dropped.
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
  uploadAudioFile: (file: File, language: string, provider?: string) => Promise<string>; // throws — unsupported
  getTranscriptionStatus: (taskId: string) => Promise<unknown>; // throws — unsupported
  isUploading: boolean; // always false
  uploadProgress: number; // always 0
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
- `uploadAudioFile()` and `getTranscriptionStatus()` **always throw** — explicitly unsupported. Use `FileTranscriptionService` for file-based transcription, or read `transcriptSegments` directly for live state.
- `onStatus` (a previously-frozen-but-unwired v1 prop) also fires `'reconnecting'`/`'reconnected'` on transport reconnects, and `'provider_switched'` with `{ fromPipeline, toPipeline }` on any STT engine switch — additive behavior on an existing optional prop; apps that never pass `onStatus` are unaffected.

## 4. `useSMR`

v1 summary hook, reproduced against the gateway's v1-compat SMR shim (`apps/api`'s `smr-compat` module, `@Controller('api/smr/api/v1')`).

```ts
function useSMR(props?: {
  sessionId?: string;
  onComplete?: (summary: SummaryResponse) => void;
  onError?: (error: ErrorInfo) => void;
}): {
  summarize: (request: SMRRequest) => Promise<SummaryResponse>; // alias of summarizeSync
  summarizeSync: (request: SMRRequest) => Promise<SummaryResponse>;
  summarizeAsync: (request: SMRRequest) => Promise<SMRJobStatus>; // best-effort, not part of the frozen v1 contract
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
- **Streaming (opt-in):** pass `{ stream: true, onDelta }` on `SMRRequest`/`PreSummaryRequest`. The hook switches to SSE parsing:
  - `event: delta` (`data: {"text": "..."}`) → fires `onDelta(delta, accumulated)`, where `accumulated` is the running concatenation including this delta.
  - `event: result` → resolves the promise with the same v1-shaped body the non-streaming path returns.
  - `event: error` (`data: {"detail": "..."}`) → rejects with that detail message.
  Omitting `stream` (or setting it `false`) is **byte-identical** to the existing single-JSON-response path — nothing changes for callers who don't opt in.

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
- **Pre-start selection:** if called **before any capture session exists**, the target is recorded in the store (`pendingSttProvider`) instead of rejecting, and is applied automatically as `startOn` at the next `audio.start(...)` call by whichever start-hook (`useAudioCapture` or `useArcaSpeechToText`) runs first.
- `onProviderSwitched` fires for **every** switch in **either** direction — both an automatic switch (e.g. a backend provider outage) and a user-initiated one — derived from `activePipeline.isFallback` flipping. The delivered `reason` is `'auto'` or `'user'`.
- **Degraded posture** on a deployment predating TASK-567 (no fallback configured): `activePipeline` stays `null`, `fallbackAvailable` is `false`, and switch calls reject cleanly with a structured `ErrorInfo` — never a crash or a silent no-op.

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

## 7. Reproduced v1 type surface

`compat.ts` re-exports the following types verbatim from the frozen v1 contract (`compat/types.ts`), so a v1 app keeps compiling against familiar names:

`V1SdkConfig`, `V1AudioSettings`, `ErrorInfo`, `SessionStatus`, `MedicalSession`, `SessionMetadata`, `PatientInfo`, `ProviderInfo`, `AudioDeviceStatus`, `SummaryResponse`, `MedicalSummary` (union of `EnhancedMedicalSummary | SimplifiedMedicalSummary | SoapMedicalSummary`), `EnhancedMedicalSummary`, `SimplifiedMedicalSummary`, `SoapMedicalSummary`, `SMRRequest`, `SMRJobStatus`, `ConversationSegmentInput`, `TestResult`, `PreviousVisitRecord`, `PreSummaryRequest`, `PreSummaryResponse`, `StructuredPreSummary`, `PreSummarySection`, `PreSummarySectionItem`, `ProviderSwitchInfo`.

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

## 8. Defects/anti-patterns deliberately not reproduced

Documented in [`TASK-560 README §6`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/README.md):

| Id | v1 behavior | Why it's not reproduced |
| --- | --- | --- |
| A1 | Hardcoded default `apiKey`/`encryptionKey` when config omitted them | `mapV1ConfigToAgenticConfig` throws instead — a real key is always required |
| F1 | Binary WS audio frames could arrive corrupted | Moot — v2 owns transport entirely; `sendAudioData` never sends audio |
| F2 | Whole transcript collapsed into one `speaker: 'user'` conversation segment | `useSMR` always builds real per-turn segments |
| I1 | Two unrelated session ids used interchangeably | v2 has one canonical `Consultation.id` |
| I2 | No confidence score on v1 transcripts | v2's `TranscriptSegment.confidence` is exposed in delivered metadata |

## Related docs

- [`../README.md`](../README.md) — full SDK overview (core hooks, audio pipeline, session lifecycle)
- [`docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md) — step-by-step migration walkthrough with a full before/after example
- [`docs/implementation/TASK-560-v1-v2-consultation-migration/README.md`](../../../docs/implementation/TASK-560-v1-v2-consultation-migration/README.md) — frozen contract (§5) and anti-patterns (§6)
- [`docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md`](../../../docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md) — the live-transcription metadata contract in full
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
| `src/compat/useSMR.ts` | |
| `src/compat/useArcaSttProvider.ts` | |
| `src/hooks/useArcaSttLanguageModes.ts` | Re-exported via `compat.ts` |
| `src/compat/types.ts` | Reproduced v1 type surface |
| `src/compat/__tests__/` | Unit tests for every hook above, plus `contract.test.ts` and `metadata-passthrough.contract.test.ts` |
