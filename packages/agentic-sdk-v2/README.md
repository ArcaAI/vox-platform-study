# @arcaai/vox

React SDK for ARCAAI medical consultation workflows. Provides a configuration-driven provider (`AgenticProvider`), a unified `useArca()` hook plus 40+ focused hooks, a real-time audio pipeline (noise filtering, voice activity detection, speech-to-text), consultation/context/summary management against the HOPE API gateway, and multi-tenant-safe browser state (per-provider Zustand stores, namespaced persistence, cross-tab sync).

Last updated: 2026-07-04

## Where it fits

| Direction     | Package / app                                        | Relationship                                                                |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Depends on    | `@arcaai/room`                                       | Audio capture, `AudioTrack`, processor contract, `AudioMixer`               |
| Depends on    | `@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt` | Stages of the transcription pipeline                                        |
| Optional peer | `@arcaai/med-ner`                                    | Browser NER stage; hook at `@arcaai/vox/plugins/med-ner`                    |
| Optional peer | `highlight.run`                                      | Optional logging transport                                                  |
| Talks to      | `apps/api` (NestJS gateway, port 8868)               | REST + WebSocket/SSE (streaming ASR via the STT service behind the gateway) |
| Consumed by   | `apps/ui-playground` (deprecated)                    | Only current in-repo consumer                                               |

Peer dependencies: `react` / `react-dom` `^18.3.0 || ^19.0.4`.

## Entry points

| Import                        | Contents                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@arcaai/vox`                 | Everything: core + audio plugin hooks and pipelines                                                                                  |
| `@arcaai/vox/core`            | Provider, hooks, types, client — no audio/ML plugin code                                                                             |
| `@arcaai/vox/plugins`         | `useVAD`, `useSTT`, `useNoiseFilter`, `useArcaAudio`, `useSttProviderToggle`, `useTtsPlayback`/`useTtsStream`, `PluginManager`, pipelines |
| `@arcaai/vox/plugins/med-ner` | `useMedNER` only — isolates the optional `@arcaai/med-ner` dependency so the main plugins entry never fails when it is not installed |
| `@arcaai/vox/compat`          | v1 (`@arcaai/agentic-sdk`) source-compatible hooks for migrating apps — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat)  |

Use `/core` for admin/dashboard surfaces that only need API access; audio and ML dependencies stay out of that graph.

**Entry bundles don't share a React context.** Each entry (`.`, `/core`, `/plugins`, `/plugins/med-ner`, `/compat`) is built as a separate bundle (`tsup.config.ts`, `splitting: false`), so a component tree rendered under `<ArcaCompatProvider>` (from `/compat`) must import every hook it uses — including v2-native ones like `useArcaSttLanguageModes` — from `/compat` too. Importing the "same" hook from `/core` in a `/compat`-provided tree throws (`useStoreApi()` finds no provider), even though the hook is re-exported under an identical name.

## Directory structure

```
packages/agentic-sdk-v2/
├── src/
│   ├── index.ts / core.ts / plugins.ts / plugins-med-ner.ts   # Entry points
│   ├── providers/     # AgenticProvider (owns one store instance per mount)
│   ├── hooks/         # useArca + focused domain/admin hooks (~45)
│   ├── store/         # Zustand store: createAgenticStore, useArcaStore, useStoreApi
│   ├── core/          # AgenticClient, ConfigManager/ConfigSchema (valibot),
│   │                  # PluginManager, TranscriptionPipeline, KnowledgePipeline,
│   │                  # SttWebSocketClient, SSEClient, StreamingSessionManager,
│   │                  # SharedConnectionManager/Worker, SimpleCrossTabSync,
│   │                  # PersonalizationManager, ModelRegistry, LocalVoiceEmbedder,
│   │                  # DualStreamRecorder, ProcessedAudioTap, FileTranscriptionService,
│   │                  # logger/ (SDKLogger + transports)
│   ├── types/         # Config, consultation, context, summary, STT, admin types
│   ├── utils/         # Diff, dates, errors, idempotency, citations, voice embedding
│   └── compat/        # v1-compat provider + hooks (entry: src/compat.ts) — see below
├── docs/API-Reference.md   # Full generated API reference
├── e2e/               # Playwright tests (fixtures + specs)
├── CHANGELOG.md
└── tsup.config.ts     # ESM + CJS for all four entries
```

## Quick start

```tsx
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.example.com',
    accessToken: 'jwt-from-your-auth-flow', // or apiKey for system keys
    tenantId: 'tenant-id',
  },
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en-US' },
  },
  debug: false,
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}

function ConsultationPage() {
  const { session, audio, context, summary, isReady, error } = useArca();

  const handleStart = async () => {
    // Get-or-create today's consultation for the patient
    await session.open({ patientId: 'patient-123' });
    await audio.start(); // pass { pipelineId } to stream via the backend ASR pipeline
  };

  if (!isReady) return <div>Loading…</div>;

  return (
    <div>
      {!session.consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <>
          <p>
            Level: {audio.level}% — Speaking: {audio.isSpeaking ? 'Yes' : 'No'}
          </p>
          {audio.currentTranscript && <p>{audio.currentTranscript}…</p>}
          {context.transcriptions.map((t) => (
            <p key={t.id}>{t.content}</p>
          ))}
        </>
      )}
    </div>
  );
}
```

`useArca()` returns `{ session, audio, context, summary, pipelines, lifecycle, isAudioSource, isReady, error, withRetry }`. The same domains are available as focused hooks (`useArcaSession`, `useArcaAudio`, `useArcaContext`, `useArcaSummary`, `useArcaConfig`) when you do not want the aggregate.

## Architecture

### Provider and store

Each `AgenticProvider` mount creates its own Zustand store via `createAgenticStore()` and publishes it through context. Read it with the public accessors:

- `useArcaStore(selector)` — reactive, context-backed (same hook the SDK uses internally).
- `useStoreApi()` — the nearest provider's `StoreApi` for imperative `.getState()` reads.

Both throw outside an `AgenticProvider`. The exported `useAgenticStore` is a deprecated module singleton kept only for backwards compatibility — no provider initializes it, so its `apiClient`/`configManager` stay `null`; do not use it in new code. On tenant switch the provider calls `store.clearTenantSessionData()` before the new tenant config resolves, wiping tenant-scoped PHI/session state.

### Audio pipeline (TranscriptionPipeline)

`PluginManager` builds a `TranscriptionPipeline` that composes the audio packages as lazily-created stages on a `@arcaai/room` track:

```
Microphone → @arcaai/room AudioTrack
  → NoiseFilter stage (@arcaai/noise-filter, RNNoise WASM)
  → VAD stage (@arcaai/vad, Silero v5)
  → STT stage (@arcaai/stt: local Whisper worker, or backend streaming)
  → transcription events → store → context items
```

Per-capture runtime options flow through `useArcaAudio.start(options)` (`AudioStartOptions`): `pipelineId` (selects the backend ASR pipeline and switches the STT stage to a streaming transport built on `StreamingSessionManager` + `SttWebSocketClient`), `language`, `deviceId`, and `secondaryDeviceId` (second microphone mixed in via `AudioMixer` before the pipeline). `DualStreamRecorder` can record raw and processed tracks in parallel, and `createProcessedAudioTap` exposes the genuine post-RNNoise audio as a recordable stream without running the full pipeline.

> **Local (in-browser) transcription is disabled platform-wide (TASK-545).** `LOCAL_TRANSCRIPTION_ENABLED` in `src/core/constants.ts` gates the STT stage's local/offline path — it currently reads `false`, so `TranscriptionPipeline.resolveSTTRuntimeProvider()` never resolves to `'local'`: a configured backend transport (`stt.sttSocket`/`stt.streamingTransport`) resolves to `'remote'`; with no transport it throws `AgenticError('LOCAL_TRANSCRIPTION_DISABLED', ...)` instead of silently transcribing on-device (the local Whisper processor is never constructed while the flag is off — no model-download side effects). NoiseFilter and VAD are unaffected — they keep running in the browser as preprocessing stages for the backend stream. **To re-enable**, flip `LOCAL_TRANSCRIPTION_ENABLED` back to `true`; it is the single, findable switch.

### Knowledge pipeline

`KnowledgePipeline` post-processes transcription text with per-stage `location` (`browser`/`backend`/`auto`/`disabled`) and `triggerMode` (`auto`/`manual`): NER (browser via optional `@arcaai/med-ner`, or backend NLP), spell-check, and summarization (backend SMR via `AgenticClient`).

### Transports and cross-tab behaviour

| Component                                              | Purpose                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `AgenticClient`                                        | REST client: auth/refresh (single-slot 401 handler, `autoWireTokenRefresh`), idempotency keys, optimistic locking (ETag/If-Match) |
| `SttWebSocketClient`                                   | Streaming ASR WebSocket (audio frames out, transcripts in, reconnect)                                                             |
| `SSEClient`                                            | Server-sent events (job progress)                                                                                                 |
| `FileTranscriptionService` / `TranscriptionJobService` | File-based transcription jobs                                                                                                     |
| `SharedConnectionManager` + `SharedConnectionWorker`   | One shared WS/SSE connection across tabs (SharedWorker), dedup keyed per user                                                     |
| `SimpleCrossTabSync`                                   | BroadcastChannel `agentic.<tenantId>`, HMAC-authenticated messages (`CrossTabHmacKeyManager`, per-tenant HKDF subkeys)            |

### Consultation session lifecycle

1. `session.open({ patientId, appointmentDate? })` — get-or-create the consultation; related visits are exposed via `session.relatedConsultations` and `useConsultationChain`.
2. `audio.start(...)` — capture + pipeline; transcripts land in `context.transcriptions`; entities in `context.entities`.
3. `context.addCaseNote(...)`, `context.extractEntities()` — enrich the record.
4. `summary.generateSummary(...)` (or `generateSummaryAsync` for job-based generation with SSE progress) — versioning, diffs, and approval flows are exposed on `useArcaSummary`.
5. `audio.stop()`, then `useArcaSession().close()` (or a status `update`) closes out the visit; `reopen()` reverses it.

### Personalization and models

`PersonalizationManager` (IndexedDB) and `ModelRegistry` (custom STT/VAD/NER model definitions with load progress) persist per `${tenantId}::${userId}` namespace and re-key on auth/tenant switch. `LocalVoiceEmbedder` provides in-browser speaker embeddings (WavLM) for voice enrollment alongside the backend `useVoiceEmbedding`.

### Logging

`SDKLogger` with pluggable transports (`ConsoleTransport`, `HighlightTransport`, `LokiTransport`, `OTelTransport`), PII redaction, and W3C trace-context helpers. Configure via `config.logging`; access with `useSDKLogger()`.

## Migrating from v1 (`@arcaai/vox/compat`)

`@arcaai/vox/compat` lets a HOPE v1 app (`@arcaai/agentic-sdk`) move to this SDK by changing an import specifier and adding one provider — no rewrite of call sites. Compat hooks are thin adapters that **only consume the public v2 API** (the hooks/store/clients documented above); they never reach into v2 internals. Every compat module carries `"use client"`.

**Full migration walkthrough:** [`docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`](../../docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md) — 3-step checklist, side-by-side hook table, endpoint-parity table, full before/after code sample, verification checklist.
**Frozen API contract:** [`docs/implementation/TASK-560-v1-v2-consultation-migration/README.md`](../../docs/implementation/TASK-560-v1-v2-consultation-migration/README.md) §5 (canonical v1 shapes) and §6 (v1 defects/anti-patterns deliberately **not** reproduced — hardcoded default API keys, collapsed conversation segments, binary WS frame corruption, and others).
**Live-transcript metadata contract:** [`docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md`](../../docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md).

### Setup

```tsx
import { ArcaCompatProvider } from '@arcaai/vox/compat';

const v1Config = {
  apiEndpoint: 'https://api.arcaai.example.com', // bare origin, NOT /api/v1 — the adapter normalizes it
  websocketUrl: 'wss://api.arcaai.example.com',
  credentials: { apiKey: 'your-api-key' }, // REQUIRED — mapV1ConfigToAgenticConfig throws without it
  tenantId: 'tenant-id',
  sttPipelineId: 'pipeline-id',
  enableProviderSwitch: true, // required only if you use useArcaSttProvider().switchToPipeline()
};

<ArcaCompatProvider options={v1Config}>
  <ConsultationPage />
</ArcaCompatProvider>;
```

`ArcaCompatProvider` maps `options` via `mapV1ConfigToAgenticConfig` and renders `AgenticProvider` underneath — it's a drop-in replacement for a v1 provider, not a second store. Unlike v1, it does **not** fall back to a hardcoded default API key/encryption key when `credentials.apiKey` is missing — it throws instead (a deliberate fix, not a bug).

### Hook reference

| v1 hook | Adapts | Purpose | Key gotchas |
| --- | --- | --- | --- |
| `useArcaSessionManager` | `useArcaSession` | Session CRUD (`createSession`, `startSession`, `pauseSession`, `resumeSession`, `endSession`, `loadSession`, `updateSession`) | `createSession` + `startSession` collapse onto **one** idempotent `session.open(...)` — calling both never double-opens. `doctorId` is never sent to the server (preserved only in `session.metadata.legacyDoctorId`); v2 derives the provider from auth. `pauseSession`/`resumeSession` are **local-only** — no backend call exists for them. |
| `useAudioCapture` | `useArcaAudio` | Mic capture (`startRecording`, `stopRecording`, `getDeviceStatus`) | `onAudioData` is accepted for source-compat but **never invoked** — v2 owns the full capture→mix→noise→VAD→STT pipeline internally. Shares one `useArcaAudio()` instance with `useArcaSpeechToText`, so pairing both (as v1 apps do) never double-starts the mic. |
| `useArcaSpeechToText` | v2's pull-state transcript model | Live transcription (`startTranscription`, `stopTranscription`, `sendAudioData`, `onTranscript` callback) | The **most nuanced compat hook** — see "Live transcription metadata" below. `sendAudioData` is a **metadata-only sink**; it never transmits audio (v2 owns transport). `uploadAudioFile`/`getTranscriptionStatus` throw — explicitly unsupported, use `FileTranscriptionService` or read `transcriptSegments` directly. |
| `useSMR` | the gateway's v1-compat SMR shim | Summarization (`summarize`/`summarizeSync`, `summarizeAsync`, `preSummarize`) | Calls literal v1 paths (`POST /api/smr/api/v1/summary/sync` etc.) **outside** the `/api/v1` prefix via a raw `fetch`, not `AgenticClient.post`. Builds real per-turn `conversation_segments` (v1 collapsed the whole transcript into one blob — a fixed defect). `summarizeAsync` is best-effort, not part of the frozen v1 shim contract — prefer `summarizeSync`. Tenant context is mandatory; there is no SYSTEM-default fallback. Pass `{ stream: true, onDelta }` to consume incremental SSE deltas instead of waiting for the full result. |
| `useArcaSttProvider` | `useArcaAudio`'s `activePipeline`/`switchProvider()` | Runtime STT engine toggle (no v1 ancestor — an additive capability) | `switchToPipeline()` (back to the SDK-configured primary) requires `enableProviderSwitch: true` on the provider, or it rejects with `SWITCH_FAILED`. `switchToFallback`/`switchToDefault` always work. Both directions are idempotent; a switch requested before any capture session exists is queued (`pendingSttProvider`) and applied at the next `audio.start(...)`. |
| `useArcaSttLanguageModes` | — (v2-native) | Language/mode picker (`modes`, `refresh`) feeding `audio.start({ languageMode })` | Re-exported from `/compat` purely so it shares a bundle with `ArcaCompatProvider` (see the entry-bundle note above) — import it from `/compat`, not `/core`, inside a compat tree. |

### Live transcription metadata (`useArcaSpeechToText`)

This hook reproduces v1's push-style `onTranscript(text, isFinal, metadata)` callback over v2's pull-based `transcriptSegments`/`currentTranscript` store state by diffing them on every render. Details that matter when integrating it:

- **Final text is templated** (`transcriptTemplate`, default `"{timestamp} {speaker_id}: {text}"`); **interim text is delivered raw** (no speaker/timestamp exists yet for an in-progress utterance).
- **`sendAudioData(data, metadata)` never transmits `data`** — it records `metadata` onto a bounded (256-entry, drop-oldest) capture-relative timeline for later correlation with finalized segments. Metadata over 8 KiB (`JSON.stringify(metadata).length > 8192`) throws, matching v1's `MAX_METADATA_BYTES` guard.
- **Delivered-metadata precedence** (lowest → highest): v2 enrichments (`speaker_id`, `confidence`, `language`, `startTime`, `endTime`, `isFinal`) are overridden by your own metadata keys, which are in turn overridden by `chunk_id`/`detected_language` when present. In short: **your metadata wins over the hook's enrichments** — set `speaker_id`/`language`/etc. yourself if you need a specific value.
- **Correlation is coarse, not byte-exact**: a final transcript picks the timeline entry closest to (but not after) its start time; interim transcripts always use the most recent entry. This matches v1's own documented guarantee.

### Working example

`apps/compat-playground` (port 5177) is a full runnable reference — `ArcaCompatProvider` setup, session + mic + live transcript + summary + provider toggle wiring, and a "view source" tab reading its own components. Its `SessionWorkspace.tsx` shows the canonical pattern:

```tsx
import {
  useArcaSessionManager,
  useAudioCapture,
  useArcaSpeechToText,
} from '@arcaai/vox/compat';

const mgr = useArcaSessionManager({ doctorId, doctorName, patientId, patientName });
const capture = useAudioCapture({ language: languageMode, languageMode });
const stt = useArcaSpeechToText({
  sessionId: mgr.session?.id ?? '',
  language: languageMode,
  transcriptTemplate: '{speaker_id}: {text}',
  options: { pipelineId, languageMode },
  onTranscript: (text, isFinal, metadata) => {
    if (isFinal) appendLine(text, metadata);
    else setInterim(text);
  },
  onError: (err) => toast.error(`STT error: ${err.message}`),
});

async function start() {
  await capture.startRecording();
  await stt.startTranscription();
}
async function stop() {
  await stt.stopTranscription();
  await capture.stopRecording();
}
```

A smaller, stripped-down example lives at `apps/example/src/compat-consultation.tsx` (hardcodes department/visit type, skips the pre-summary step).

## Hooks overview

| Group            | Hooks                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consultation     | `useArca`, `useArcaSession`, `useArcaAudio`, `useArcaContext`, `useArcaSummary`, `useArcaConfig`, `useConsultationChain`, `useConsultationJob`, `useAudioRecordings`                                                                                   |
| Auth and tenancy | `useAuth`, `useTenants`, `useTenantFrontendConfig`, `useTenantStorageConfig`, `useTenantBuckets`, `useEntitlements`                                                                                                                                    |
| Admin            | `useUsers`, `useRoles`, `useDepartments`, `useUserDepartments`, `usePolicies`, `usePrompts`, `useApiKeys`, `useAuditLog`, `useAdminConsultations`, `useAdminTranscriptionJobs`, `useHarnessAdmin`, `useQueueAdmin`, `useRateLimits`, `usePrismaStudio` |
| Platform         | `useHealthCheck`, `useMonitoring`, `usePlatformMetrics`, `usePipelines`, `useGlobalSettings`, `useUserSettings`, `useStorage`, `useStorageKeys`                                                                                                        |
| Voice and DNA    | `useVoiceEmbedding`, `useLocalVoiceEmbedding`, `useDnaStyle`, `useDnaDashboard`                                                                                                                                                                        |
| Audio plugins    | `useVAD`, `useSTT`, `useNoiseFilter` (from `/plugins`), `useMedNER` (from `/plugins/med-ner`)                                                                                                                                                          |
| Compat (v1 migration) | `ArcaCompatProvider`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useSMR`, `useArcaSttProvider`, `useArcaSttLanguageModes` (all from `/compat` — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat))                |

Full signatures and types: [docs/API-Reference.md](docs/API-Reference.md). Release history: [CHANGELOG.md](CHANGELOG.md).

## Requirements

- React `^18.3.0` or `^19.0.4` (security-patched versions; the SDK is client-side only and every entry carries `"use client"`).
- Modern browser with Web Audio API; microphone permission is requested when audio starts.
- Local Whisper STT benefits from cross-origin isolation (COOP/COEP) for multi-threaded inference — see `../stt/README.md`.
- To use browser NER, install the optional peer `@arcaai/med-ner` and import from `@arcaai/vox/plugins/med-ner`.
- Do not embed long-lived API keys in production client code; prefer short-lived access tokens via your auth flow. This SDK processes medical data — deploy in line with HIPAA/GDPR obligations.

## Debug mode

Set `debug: true` in the config to enable verbose `[ARCAAI:DEBUG]` console logging: pipeline configuration dumps at startup and structured transcript JSON for every final transcription result. The flag propagates `debugMode` into the noise-filter, VAD, and STT processors automatically.

## Commands

From this directory:

| Command                         | Action                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm build` / `pnpm dev`       | tsup build of all four entries / watch mode                                                        |
| `pnpm test` / `pnpm test:watch` | Vitest unit tests                                                                                  |
| `pnpm test:e2e`                 | Builds, then Playwright (`e2e/playwright.config.ts`); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint`                     | ESLint on `src`                                                                                    |
| `pnpm typecheck`                | `tsc --noEmit`                                                                                     |
| `pnpm clean` / `pnpm clean:all` | Remove build output (nuke also removes `node_modules`)                                             |

From the repo root: `pnpm --filter @arcaai/vox build` (same pattern for `test`, `lint`, etc.).

## Related packages

| Package                | Role                                      |
| ---------------------- | ----------------------------------------- |
| `@arcaai/room`         | Audio capture, tracks, processor pipeline |
| `@arcaai/noise-filter` | RNNoise WASM noise cancellation           |
| `@arcaai/vad`          | Silero voice activity detection           |
| `@arcaai/stt`          | Whisper STT (worker) + backend streaming  |
| `@arcaai/med-ner`      | Optional browser medical NER              |

## License

MIT
